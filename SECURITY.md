# Security Policy

## Supported Versions
Only the latest version of the extension is supported. Please ensure you are running the most recent code from the `main` branch.

## Reporting a Vulnerability
**Please do not open a public issue for security vulnerabilities.**

If you discover a security-related bug, please report it privately via [GitHub's private vulnerability reporting](https://github.com/humanchaos/factcheck/security/advisories/new). We aim to respond to all reports within 48 hours.

## Our Commitment
* We store API keys locally using `chrome.storage.local`.
* We use safe DOM manipulation utilities (`security-utils.js`) to prevent XSS when rendering fact-check results.
* We prioritize user privacy and data minimization.
