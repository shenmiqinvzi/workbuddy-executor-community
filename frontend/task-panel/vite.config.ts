import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 只监听 loopback；端口与网关分开。没有任何代理或 live 模式开关。
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    css: false,
  },
})
