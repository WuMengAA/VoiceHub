// 全局类型声明文件

interface Window {
  $showNotification: (message: string, type?: 'success' | 'error' | 'info') => void
}

// Vite 以 ?raw 后缀导入文件时返回原始字符串（用于把帮助文档 HTML 整段喂给 v-html）
declare module '*?raw' {
  const content: string
  export default content
}
