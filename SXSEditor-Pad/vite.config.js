import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  root: "src",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/index.html"),
        fragmentEditor: path.resolve(__dirname, "src/fragmentEditor.html"),
        audioPreprocess: path.resolve(__dirname, "src/audioPreprocess.html"),
        settings: path.resolve(__dirname, "src/settings.html"),
        singerCreator: path.resolve(__dirname, "src/singerCreator.html"),
        singerMarket: path.resolve(__dirname, "src/singerMarket.html"),
        modelDownload: path.resolve(__dirname, "src/modelDownload.html"),
        resourceManager: path.resolve(__dirname, "src/resourceManager.html"),
        splash: path.resolve(__dirname, "src/splash.html"),
        updateNotification: path.resolve(__dirname, "src/updateNotification.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
});