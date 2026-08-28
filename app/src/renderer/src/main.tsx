import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ConfigEditor from './ConfigEditor'
import './styles.css'

// hash 路由：#/editor 打开配置编辑器（独立窗口），默认渲染菜单栏面板
const isEditor = window.location.hash.includes('editor')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isEditor ? <ConfigEditor /> : <App />}</React.StrictMode>
)
