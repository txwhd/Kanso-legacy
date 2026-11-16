//! Read the trust store strictly, before making any trust decision. russh's
//! file helper treats all open errors as an empty store and skips malformed
//! records; neither is safe to interpret as a first connection.
use std::io::Write;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use russh::keys::PublicKey;

use crate::error::{AppError, Result};

pub(super) struct Entry {
    pub line: usize,
    hosts: String,
    pub key: PublicKey,
}

pub(super) struct TrustFile {
    content: String,
    entries: Vec<Entry>,
}

fn invalid(path: &Path, line: usize, reason: &str) -> AppError {
    AppError::new(format!(
        "invalid trust file {} line {line}: {reason}",
        path.display()
    ))
}

impl TrustFile {
    pub fn read(path: &Path) -> Result<Self> {
        let content = match std::fs::read_to_string(path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => {
                return Err(AppError::new(format!(
                    "cannot read trust file {}: {error}",
                    path.display()
                )))
            }
        };
        let mut entries = Vec::new();
        for (index, raw) in content.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 3 || fields[0].starts_with('@') {
                return Err(invalid(
                    path,
                    index + 1,
                    "expected host, key type and public key; trust markers are not supported",
                ));
            }
            for host in fields[0].split(',') {
                let host = host.strip_prefix('!').unwrap_or(host);
                if host.is_empty() || host == "!" {
                    return Err(invalid(path, index + 1, "empty host pattern"));
                }
                if host.starts_with('|') {
                    let parts: Vec<_> = host.split('|').collect();
                    if parts.len() != 4
                        || parts[1] != "1"
                        || STANDARD
                            .decode(parts[2])
                            .map_or(true, |bytes| bytes.len() != 20)
                        || STANDARD
                            .decode(parts[3])
                            .map_or(true, |bytes| bytes.len() != 20)
                    {
                        return Err(invalid(path, index + 1, "invalid hashed hostname"));
                    }
                }
            }
            let key = PublicKey::from_openssh(&format!("{} {}", fields[1], fields[2]))
                .map_err(|_| invalid(path, index + 1, "invalid public key"))?;
            entries.push(Entry {
                line: index + 1,
                hosts: fields[0].to_owned(),
                key,
            });
        }
        Ok(Self { content, entries })
    }

    pub fn keys<'a>(&'a self, host: &str, port: u16) -> Vec<&'a Entry> {
        let address = if port == 22 {
            host.to_owned()
        } else {
            format!("[{host}]:{port}")
        };
        self.entries
            .iter()
            .filter(|entry| matches_hosts(&address, &entry.hosts))
            .collect()
    }

    pub fn record(
        &self,
        path: &Path,
        host: &str,
        port: u16,
        key: &PublicKey,
        replace: bool,
    ) -> Result<()> {
        let matching = self.keys(host, port);
        if !replace && matching.iter().any(|entry| entry.key == *key) {
            return Ok(());
        }
        if !replace
            && matching
                .iter()
                .any(|entry| entry.key.algorithm() == key.algorithm())
        {
            return Err(AppError::new("host key changed while confirmation was open; reconnect and verify the new fingerprint"));
        }
        let removed: std::collections::HashSet<_> = if replace {
            matching.iter().map(|entry| entry.line).collect()
        } else {
            Default::default()
        };
        // Removing a shared or wildcard entry would also revoke unrelated
        // hosts. Leave it intact and ask the operator to edit it explicitly.
        if replace
            && matching
                .iter()
                .any(|entry| entry.hosts.contains([',', '*', '?', '!']))
        {
            return Err(AppError::new(
                "cannot replace a shared known_hosts entry; update that entry manually",
            ));
        }
        let mut content = String::new();
        for (index, raw) in self.content.split_inclusive('\n').enumerate() {
            if !removed.contains(&(index + 1)) {
                content.push_str(raw);
            }
        }
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        let address = if port == 22 {
            host.to_owned()
        } else {
            format!("[{host}]:{port}")
        };
        let public = key
            .to_openssh()
            .map_err(|e| AppError::new(format!("cannot encode host key: {e}")))?;
        content.push_str(&format!("{address} {public}\n"));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Write a sibling first: a failed write must leave existing trust intact.
        let temporary = path.with_file_name(format!(".known_hosts-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(content.as_bytes())?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result.map_err(|e| AppError::new(format!("cannot save trust file {}: {e}", path.display())))
    }
}

fn matches_hosts(host: &str, patterns: &str) -> bool {
    let mut matched = false;
    for pattern in patterns.split(',') {
        let (negated, pattern) = pattern
            .strip_prefix('!')
            .map_or((false, pattern), |p| (true, p));
        let yes = if pattern.starts_with("|1|") {
            let parts: Vec<_> = pattern.split('|').collect();
            match (STANDARD.decode(parts[2]), STANDARD.decode(parts[3])) {
                (Ok(salt), Ok(hash)) => {
                    let key =
                        ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &salt);
                    ring::hmac::verify(&key, host.as_bytes(), &hash).is_ok()
                }
                _ => false,
            }
        } else {
            wildcard(host.as_bytes(), pattern.as_bytes())
        };
        if yes && negated {
            return false;
        }
        matched |= yes;
    }
    matched
}

// Literal brackets (non-default ports/IPv6), with OpenSSH's * and ? wildcards.
fn wildcard(text: &[u8], pattern: &[u8]) -> bool {
    let (mut t, mut p, mut star, mut retry) = (0, 0, None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            t += 1;
            p += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = t;
        } else if let Some(s) = star {
            retry += 1;
            t = retry;
            p = s + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}
