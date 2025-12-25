import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Demo build config - uses DemoApp entry point
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-demo',
    rollupOptions: {
      input: {
        main: './demo.html'
      }
    }
  }
})
