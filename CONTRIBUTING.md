# Contributing to factcheck 🗳️

First off, **thank you for being here!** Building a tool to protect democratic discourse is a massive undertaking, and we're glad you're part of it.

---

## ⚠️ The Honest Truth

Let's be real: This project is far from perfect. The code is in its early stages, the logic needs tightening, and there are likely edge cases we haven't even discovered yet. We didn't release this because it's "finished"—we released it because the mission is too urgent to wait for perfection.

**This is where you come in.** We need your brainpower to help us optimize, refactor, and scale this into a tool that can truly make a difference. No contribution is too small.

---

## 🚦 How Can I Contribute?

### 1. Reporting Bugs

- Check the [Issues](https://github.com/humanchaos/factcheck/issues) tab to see if the bug has already been reported.
- If not, open a new issue. Since we are in early stages, please be as descriptive as possible about what went wrong.

### 2. Suggesting Enhancements

Have a better way to parse DOM elements? A faster NLP approach? Open an issue with the tag `enhancement` to discuss your idea.

### 3. Pull Requests (Code)

- Fork the repo and create your branch from `main`.
- Ensure your code follows the existing style.
- Issue a Pull Request (PR) with a clear description of what you improved or "un-broke."

---

## 🛠️ Local Development Setup (Chrome Extension)

To work on this extension, you need to load it into Chrome manually.

### 1. Clone

```bash
git clone https://github.com/humanchaos/factcheck.git
cd factcheck
```

### 2. Load into Chrome

1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer Mode** (top right toggle).
3. Click **Load unpacked**.
4. Select the folder where your `manifest.json` is located.
5. The factcheck icon should now appear in your browser bar.

### 3. Testing Changes

Whenever you save your code, click the **Reload icon (↻)** on the extension card in `chrome://extensions/` to see your changes in action.

---

## 🎨 Our "Work in Progress" Standards

- **Function over Form (For Now):** While we want clean code, we prioritize accuracy and speed of fact-checking above all else.
- **Privacy First:** This tool reads web content. Never log, store, or transmit sensitive user data.
- **Keep it Light:** Chrome extensions can be resource hogs. We want to keep our memory footprint as small as possible.

---

## 📜 Code of Conduct

By participating, you agree to keep the discussion constructive and focused on the mission of factual integrity. We are a community of builders, not trolls.
