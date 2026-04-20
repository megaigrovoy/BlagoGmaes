import { defineConfig } from 'vite'
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
  server: {
    host: true
  }
})
