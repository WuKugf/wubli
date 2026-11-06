# wubli · B 站视频批量解析下载

批量粘贴 B 站视频链接，自动解析标题 / 分 P / 可用画质，一键下载为 MP4。

## 功能

- 批量解析：支持视频链接、BV 号、av 号、b23.tv 短链，单次最多 20 条
- 多画质选择：游客模式最高 480P，登录后解锁 1080P / 4K
- 扫码登录：B 站 App 扫码即可登录，无需手动复制 Cookie（也保留了手动填 SESSDATA 的方式）
- 分片并行下载 + 断点取消，服务端 ffmpeg 合成完整 MP4
- Cookie（SESSDATA）仅保存在本机服务内存中，不上传、不落盘

## 本地运行（推荐）

需要 Node.js ≥ 18 和 ffmpeg。

```bash
npm install
npm start
# 打开 http://localhost:3200
```

安装 ffmpeg：

- Windows：`winget install ffmpeg`（或官网下载后加入 PATH）
- macOS：`brew install ffmpeg`
- Ubuntu/Debian：`sudo apt install ffmpeg`

## 部署

本项目包含后端服务，**不能直接部署到 GitHub Pages**（纯静态）。推荐以下方式：

### Docker（任意支持 Docker 的平台，最简单）

仓库自带 `Dockerfile`，可直接部署到 Render、Railway、Hugging Face Spaces、Fly.io 等：

```bash
docker build -t wubli .
docker run -p 3200:3200 wubli
```

以 Render 为例：New → Web Service → 连接本仓库 → Runtime 选 **Docker** → 部署即可（免费实例会休眠，首次访问稍慢）。

### 无 Docker 的 Node 平台

- Build：`npm install` 并确保环境中有 ffmpeg
- Start：`npm start`
- 端口：读取环境变量 `PORT`（默认 3200）

## 如何获取 SESSDATA（解锁 1080P / 4K）

1. 用电脑浏览器（Chrome / Edge）打开 [bilibili.com](https://www.bilibili.com) 并登录
2. 按 `F12`（或右键页面 → 检查）打开开发者工具
3. 点顶部 **Application**（应用）标签 → 左侧展开 **Cookies** → 点击 `https://www.bilibili.com`（Edge 在「存储 → Cookie」下）
4. 在列表中找到 `SESSDATA` 一行，双击 **Value** 列，全选复制
5. 粘贴到本站「设置」弹窗中保存即可

有效期约 30 天，过期后重新获取。不登录也能用，游客模式可下载 480P。

## 技术栈

Node.js + Express 后端，原生 HTML/CSS/JS 前端，ffmpeg 合成音视频。

## 免责声明

仅供个人学习与离线观看，请尊重 UP 主版权，勿用于商业传播。
