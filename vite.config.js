import { defineConfig, defaultClientConditions } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [
    basicSsl(),
    /**
     * Cloudflare Rocket Loader откладывает/переписывает скрипты — на тяжёлых canvas+WASM играх
     * это даёт рывки rAF при том же коде, что на localhost без CF.
     * Атрибут официально отключает RL для этого тега.
     * @see https://developers.cloudflare.com/speed/optimization/content/rocket-loader/ignore-javascripts/
     */
    {
      name: 'cloudflare-skip-rocket-loader',
      transformIndexHtml(html) {
        if (html.includes('data-cfasync=')) return html
        return html.replace(/<script\s+type="module"/g, '<script data-cfasync="false" type="module"')
      }
    }
  ],
  resolve: {
    /**
     * onnxruntime-web без встроенного wasm: рантайм (26+ МБ, больше лимита Cloudflare Pages 25 МБ)
     * грузится с jsDelivr — см. ort.env.wasm.wasmPaths в src/rtm/worker.js
     */
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions]
  },
  server: {
    host: true
  }
})
