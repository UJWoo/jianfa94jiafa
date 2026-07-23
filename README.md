# 輕壓工具箱

純前端的 PDF 與圖片壓縮網站。檔案只在使用者的瀏覽器內處理，不會上傳至伺服器。

## 功能

- PDF：品質與頁面解析度控制、逐頁處理、壓縮前後容量比較。
- 圖片：JPG／PNG／WebP、批次壓縮、尺寸縮放、格式轉換、ZIP 打包下載。
- 響應式介面：支援桌面與手機。

> PDF 壓縮會將頁面重新渲染成圖片，因此壓縮後可能無法搜尋或選取文字。

## 發布到 GitHub Pages

1. 在 GitHub 建立一個新的 repository。
2. 將本資料夾內的所有檔案上傳至 repository 根目錄。
3. 進入 `Settings` → `Pages`。
4. 在 `Build and deployment` 的 `Source` 選擇 `GitHub Actions`。
5. 回到 `Actions` 頁面等待 `Deploy to GitHub Pages` 完成。

之後每次更新 `main` 分支，網站都會自動重新發布。

## 本機執行

```bash
npm install
npm run dev
```
