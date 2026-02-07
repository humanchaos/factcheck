# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-02-07

### Added
- **Multilingual i18n**: Full UI support for 6 languages (DE, EN, FR, ES, IT, PT) with browser auto-detection and live language switching via popup.
- **Sponsor/Support Links**: "Buy me a coffee" and "GitHub Sponsors" buttons in extension popup, `.github/FUNDING.yml` for repo Sponsor button.
- **Community Roadmap**: 3-phase roadmap (Foundation → Performance → Trust Engine) in README.
- **Social Preview**: Generated branded social preview image for GitHub link previews.
- **Good First Issue Template**: Reusable issue template for onboarding new contributors.

### Changed
- **Version aligned**: Manifest, popup, and CHANGELOG now all use `0.1.0`.
- **Expanded language detection**: `background.js` `detectLang()` now detects DE, FR, ES, IT, PT (was DE-only).

## [0.1.0-alpha] - 2026-02-06

### Added
- **Mission-Driven README**: Completely overhauled the project documentation to focus on democratic integrity and real-time YouTube fact-checking.
- **Project Governance**: Added `CODE_OF_CONDUCT.md` to ensure a professional and inclusive environment for all contributors.
- **Legal Foundation**: Established the MIT License to allow for maximum open-source growth and legal safety.
- **Developer Onboarding**: Created `CONTRIBUTING.md` with clear instructions for manual Chrome Extension installation and local development.
- **Safety Documentation**: Added `SECURITY.md` for vulnerability reporting and `PRIVACY.md` to define our privacy-first data handling.
- **The Trust Policy**: Created `SOURCES.md` to define the criteria for "Trusted Sources" within the tool's logic.
- **Automation**: Implemented a GitHub Actions CI/CD pipeline (`ci.yml`) to automatically check for code errors on every Pull Request.
- **Issue Templates**: Set up standardized templates for Bug Reports and Feature Requests to streamline feedback.

### Fixed
- **Repository Structure**: Organized core files and added `.gitignore` to prevent credential leakage.

### Challenged (Roadmap)
- **The API Key Problem**: Opened a major architectural issue to find ways to remove the requirement for individual user API keys.
- **The Trust Engine**: Initiated the design phase for the weighted consensus model for factual verification.
