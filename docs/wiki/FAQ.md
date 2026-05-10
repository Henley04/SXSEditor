# Frequently Asked Questions (FAQ)

## General

### What is SXSEditor?

SXSEditor is an open-source desktop singing voice synthesis (SVS) workstation. It allows you to create, edit, and synthesize vocal tracks using a visual piano-roll editor and AI-powered neural singing voice synthesis.

### Is SXSEditor free?

Yes! SXSEditor is completely free and open-source under the MIT License.

### What platforms are supported?

- **Windows**: Primary target with pre-built installers
- **macOS**: Supported via Electron Forge (build from source)
- **Linux**: Supported via Electron Forge (build from source)

---

## Models

### What models do I need?

You need the SoulX-Singer ONNX model files placed in the `onnx_models/` directory. These include encoders, the diffusion model, and the vocoder.

### Where do I get the models?

The SoulX-Singer model files need to be obtained separately. Check the repository documentation for download sources.

### Can I use my own models?

Currently SXSEditor is designed to work with the SoulX-Singer architecture. Custom model support is not available at this time.

---

## Synthesis

### What languages are supported for synthesis?

| Language | Status |
|----------|--------|
| **English** | ✅ Supported |
| **Chinese (Mandarin)** | ✅ Supported — accepts Pinyin or Chinese characters |
| **Japanese** | 🔄 In Development |
| **Korean** | 📋 Planned |

### How does Chinese lyric input work?

You can input lyrics in either **Pinyin** (e.g., `ni hao`) or **Chinese characters** (e.g., `你好`). The system will automatically convert characters to phonemes for synthesis.

### Can I use my own voice?

Yes! Use the **Singer Creator** to create a custom singer from a reference WAV audio file. The model will analyze the vocal characteristics and use them during synthesis.

---

## Hardware

### Does it work without a GPU?

Yes. ONNX Runtime will automatically fall back to CPU if no compatible GPU is detected. GPU acceleration is beneficial but not required.

### Which GPUs are supported?

DirectML supports NVIDIA, AMD, and Intel discrete GPUs. The application will automatically detect and select the best available device.

### What are the minimum system requirements?

- **OS**: Windows 10/11 (64-bit)
- **RAM**: 8 GB minimum (16 GB recommended)
- **Storage**: 2 GB for the application, additional space for models
- **CPU**: Any modern multi-core processor

---

## Troubleshooting

### The app crashes on startup

Try the following:
1. Ensure all model files are correctly placed in `onnx_models/`
2. Check that Node.js dependencies are properly installed
3. Look for error logs in the console
4. Open an issue on GitHub

### Synthesis is very slow

- Enable GPU acceleration if available
- Check that your GPU drivers are up to date
- For CPU inference, a modern multi-core processor is recommended

### Native module build errors

If you encounter errors when building from source:

```bash
npx electron-rebuild
```

---

## Contributing

### How can I contribute?

See the [Developer Guide](Developer-Guide) for detailed contribution guidelines. We welcome bug reports, feature requests, and pull requests.

### I found a bug

Please open an issue on the [GitHub Issue Tracker](https://github.com/Henley04/SXSEditor/issues) with:
- A clear description of the problem
- Steps to reproduce
- Your system configuration
- Any relevant logs or screenshots

---

## Support

### Where can I get help?

- Open an issue on [GitHub Issues](https://github.com/Henley04/SXSEditor/issues)
- Check the [User Guide](User-Guide) for detailed instructions
- Consult this FAQ for common questions