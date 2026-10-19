# Changelog

All notable changes to Deal Watch are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The version in `version.txt` and `SCRIPT_VERSION` in `src/Code.gs` must match. Bump both, add an entry here, and open a GitHub Release when publishing an update.

## [Unreleased]

## [1.0.0]

### Added

- Gmail watcher for chosen senders and keywords with one Telegram digest per check.
- Telegram button-first UI: `/add`, `/list`, `/interval`, `/status`, `/help`, `/transfer`, `/connect`.
- Optional keyword ideas via a Telegram Mini App (`/setai`) using OpenRouter.
- Version shown in `/status` and an "update available" notice on the digest when a newer release exists.
