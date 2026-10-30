# Changelog

All notable changes to lamamailer are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- A failed mail (e.g. an SMTP rate limit) now pauses the whole queue instead of moving on to the next signup, so the
  limit can recover. The pause starts at 30 seconds, doubles with every further failure in a row (up to 30 minutes)
  and ends with the first successful mail.

## [1.0.0] - 2026-10-30

First release.
