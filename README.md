# Blackiya

A high-performance Chrome extension for capturing and saving conversation JSON from popular LLM platforms (ChatGPT, Gemini, Grok, etc.).

## 🚀 Quick Start

### Prerequisites

- **Bun** v1.3+ ([Install Bun](https://bun.sh/docs/installation))
- **Chrome** or **Chromium-based browser**
- **Git**

### Bootstrap Instructions

#### Step 1: Install Bun (if not already installed)

**macOS/Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Windows:**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Verify installation:
```bash
bun --version
```

#### Step 2: Clone or Create Project

**Option A: Clone this repository**
```bash
git clone <your-repo-url>
cd blackiya
```

**Option B: Create from scratch**
```bash
# Create project directory
mkdir blackiya
cd blackiya

# Initialize git
git init

# Create package.json (see configuration files below)
```

#### Step 3: Install Dependencies

```bash
# Install all dependencies
bun install

# This will install:
# - WXT (extension framework)
# - Biome (linter & formatter)
# - TypeScript dependencies
```

#### Step 4: Project Structure Setup

Create the following directory structure:

```bash
# Create directories
mkdir -p entrypoints/content entrypoints/popup public/icon utils platforms

# Create necessary files
touch wxt.config.ts biome.json tsconfig.json
touch entrypoints/background.ts
touch entrypoints/content/chatgpt.ts
touch utils/storage.ts utils/capture.ts utils/types.ts
touch platforms/chatgpt.ts
```

#### Step 5: Configure Project Files

Copy the configuration files from the source code section below:
- `package.json`
- `wxt.config.ts`
- `biome.json`
- `tsconfig.json`
- `.gitignore`

#### Step 6: Add Extension Icons

Place icon files in `public/icon/`:
- `16.png` (16x16px)
- `48.png` (48x48px)
- `128.png` (128x128px)

> **Tip:** Use a tool like [IconKitchen](https://icon.kitchen/) to generate icons from a single source image.

#### Step 7: Development Server

Start the development server with hot module reload:

```bash
bun run dev
```

This will:
1. Build the extension in development mode
2. Watch for file changes
3. Output to `.output/chrome-mv3/` directory
4. Enable Hot Module Replacement for instant updates

#### Step 8: Load Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `.output/chrome-mv3/` directory from your project
5. The extension should now appear in your extensions list

#### Step 9: Test the Extension

1. Navigate to [ChatGPT](https://chat.openai.com)
2. Start or open a conversation
3. Look for the injected "Save Conversation" button
4. Click the button to download the conversation JSON

## 📦 Available Scripts

```bash
# Development
bun run dev              # Start dev server with HMR

# Code Quality
bun run check            # Lint and format code (auto-fix)
bun run lint             # Run Biome linter
bun run format           # Format code with Biome

# Building
bun run build            # Build for production
bun run zip              # Create distributable ZIP file

# Testing
bun test                 # Run tests (when added)
```

## 🏗️ Project Structure

```text
blackiya/
├── .output/                    # Build output (git-ignored)
│   └── chrome-mv3/            # Chrome extension build
├── entrypoints/
│   ├── background.ts          # Service worker for API interception
│   ├── content/
│   │   ├── chatgpt.ts        # ChatGPT content script
│   │   ├── gemini.ts         # Gemini content script
│   │   └── grok.ts           # Grok content script (future)
│   └── popup/
│       ├── index.html        # Extension popup UI (optional)
│       └── App.tsx           # Popup logic (optional)
├── platforms/
│   ├── chatgpt.ts            # ChatGPT platform adapter
│   ├── gemini.ts             # Gemini platform adapter
│   └── types.ts              # Platform interface definitions
├── utils/
│   ├── storage.ts            # Chrome storage utilities
│   ├── capture.ts            # Core capture logic
│   ├── download.ts           # File download utilities
│   └── types.ts              # TypeScript type definitions
├── public/
│   └── icon/                 # Extension icons
│       ├── 16.png
│       ├── 48.png
│       └── 128.png
├── .gitignore
├── biome.json                # Biome configuration
├── bun.lockb                 # Bun lock file
├── package.json              # Project dependencies
├── tsconfig.json             # TypeScript configuration
├── wxt.config.ts             # WXT framework configuration
├── AGENTS.md                 # AI agent documentation
└── README.md                 # This file
```

## 🎯 Features

### Current (Phase 2 - Gemini)

- ✅ Capture full conversation JSON from ChatGPT & Gemini
- ✅ Support for Gemini's `batchexecute` protocol
- ✅ One-click download as JSON file
- ✅ Automatic filename generation with timestamps
- ✅ UI injection into ChatGPT & Gemini interfaces
- ✅ Preserves complete message tree structure

### Roadmap

- ✅ **Phase 1:** ChatGPT support
- ✅ **Phase 2:** Gemini support
- 🔲 **Phase 3:** Grok support
- 🔲 **Phase 4:** Claude support
- 🔲 **Phase 5:** Export formats (Markdown, HTML, PDF)
- 🔲 **Phase 6:** Settings UI for customization
- 🔲 **Phase 7:** Conversation history browser

## 🔧 Configuration

### Manifest V3 Permissions

The extension requires the following permissions:

- **`storage`** - Save user preferences and temporary data
- **`downloads`** - Download conversation JSON files
- **`webRequest`** - Intercept API requests (optional, for auto-capture)
- **`activeTab`** - Access current tab for UI injection

### Host Permissions

- `https://chatgpt.com/*` - ChatGPT platform
- `https://chat.openai.com/*` - Legacy ChatGPT platform
- `https://gemini.google.com/*` - Gemini platform
- `https://x.com/*` - Grok platform (future)

## 🧪 Development Workflow

### Making Changes

1. Edit source files in `entrypoints/`, `utils/`, or `platforms/`
2. Save the file
3. WXT will automatically rebuild (watch mode)
4. Reload the extension in Chrome if needed (background script changes)
5. Refresh the target webpage (content script changes)

### Adding a New Platform

1. Create platform adapter in `platforms/your-platform.ts`
2. Implement the `LLMPlatform` interface
3. Create content script in `entrypoints/content/your-platform.ts`
4. Register in `wxt.config.ts` host permissions
5. Update background script to handle the new platform

### Code Quality

Before committing:

```bash
# Format and lint all files
bun run check

# Or separately
bun run format  # Format code
bun run lint    # Check for issues
```

### Building for Production

```bash
# Create optimized build
bun run build

# Create ZIP for Chrome Web Store submission
bun run zip
```

The ZIP file will be in `.output/` directory.

## 📝 Usage

### Basic Usage

1. Navigate to ChatGPT or Gemini and open a conversation
2. Click the "Save JSON" button (injected by extension)
3. The conversation JSON will download automatically
4. File format: `{conversation-title}_{timestamp}.json`

### Manual Capture

If the auto-inject button doesn't appear:

1. Open the extension popup (click extension icon)
2. Click "Capture Current Conversation"
3. The JSON will download

### Viewing Saved Conversations

The JSON file contains:
- Full conversation metadata (title, timestamps)
- Complete message tree structure
- All message content and metadata
- Model information
- Plugin IDs (if any)

## 🐛 Troubleshooting

### Extension Not Loading

1. Check Chrome console for errors: `chrome://extensions/` > Details > Inspect views
2. Ensure `.output/chrome-mv3/` directory exists
3. Rebuild: `bun run build`

### Button Not Appearing

1. Check if you're on a supported platform (chatgpt.com)
2. Open browser console and check for errors
3. Reload the extension: `chrome://extensions/` > Reload
4. Refresh the webpage

### Build Errors

1. Clear output: `rm -rf .output/`
2. Clear cache: `rm -rf node_modules/ bun.lockb`
3. Reinstall: `bun install`
4. Rebuild: `bun run dev`

### Biome Errors

If Biome complains about formatting:

```bash
# Auto-fix all issues
bun run check

# Or format specific files
bunx biome format --write ./entrypoints/
```

## 🤝 Contributing

### Setup for Contributors

1. Fork the repository
2. Clone your fork: `git clone <your-fork-url>`
3. Create a branch: `git checkout -b feature/your-feature`
4. Make changes and commit
5. Run code quality checks: `bun run check`
6. Push and create Pull Request

### Code Style

- Use **Biome** for formatting (configured in `biome.json`)
- Follow TypeScript best practices
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Keep functions small and focused

### Commit Guidelines

Use conventional commits:

```text
feat: add Gemini platform support
fix: resolve button injection timing issue
docs: update README with troubleshooting
refactor: extract common capture logic
```

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Resources

- [WXT Documentation](https://wxt.dev)
- [Chrome Extension API](https://developer.chrome.com/docs/extensions/)
- [Biome Documentation](https://biomejs.dev)
- [Bun Documentation](https://bun.sh)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## 💬 Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions
- Read the AGENTS.md file for architecture details

---

**Built with ❤️ using WXT, Bun, and Biome**