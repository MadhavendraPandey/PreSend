import { defineConfig } from 'wxt';
import { FEEDBACK_BACKEND_URL } from './src/config';

const feedbackBackendOrigin = `${new URL(FEEDBACK_BACKEND_URL).origin}/*`;

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    resolve: {
      conditions: ['onnxruntime-web-use-extern-wasm'],
    },
  }),
  manifest: {
    name: 'PreSend',
    description: 'Checks likely sensitive information locally before it is sent to supported AI chats.',
    version: '1.0.0',
    permissions: ['storage'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    host_permissions: [
      'https://chatgpt.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'https://perplexity.ai/*',
      'https://www.perplexity.ai/*',
      'https://chat.deepseek.com/*',
      'https://grok.com/*',
      feedbackBackendOrigin,
    ],
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    web_accessible_resources: [
      {
        resources: [
          'assets/content.mjs',
          'semantic/encoder_fp32.onnx',
          'semantic/classifier.json',
          'semantic/tokenizer.json',
          'semantic/ort/ort-wasm-simd-threaded.mjs',
          'semantic/ort/ort-wasm-simd-threaded.wasm',
        ],
        matches: [
          'https://chatgpt.com/*',
          'https://claude.ai/*',
          'https://gemini.google.com/*',
          'https://perplexity.ai/*',
          'https://www.perplexity.ai/*',
          'https://chat.deepseek.com/*',
          'https://grok.com/*',
        ],
      },
    ],
  },
});
