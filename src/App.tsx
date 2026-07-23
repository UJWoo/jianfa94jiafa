"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import "./styles.css";

type Mode = "pdf" | "image";
type ImageFormat = "image/jpeg" | "image/webp" | "image/png";

type ImageResult = {
  name: string;
  originalSize: number;
  resultSize: number;
  url: string;
  blob: Blob;
};

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const percentSaved = (before: number, after: number) =>
  before ? Math.max(0, Math.round((1 - after / before) * 100)) : 0;

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12m0 0 5-5m-5 5-5-5M5 21h14" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </svg>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("pdf");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [quality, setQuality] = useState(72);
  const [pdfScale, setPdfScale] = useState(1.45);
  const [maxWidth, setMaxWidth] = useState(1920);
  const [format, setFormat] = useState<ImageFormat>("image/jpeg");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [pdfResult, setPdfResult] = useState<{ url: string; size: number } | null>(null);
  const [imageResults, setImageResults] = useState<ImageResult[]>([]);
  const pdfInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  const resetResults = useCallback(() => {
    if (pdfResult) URL.revokeObjectURL(pdfResult.url);
    imageResults.forEach((item) => URL.revokeObjectURL(item.url));
    setPdfResult(null);
    setImageResults([]);
    setError("");
    setProgress("");
  }, [pdfResult, imageResults]);

  const selectMode = (next: Mode) => {
    resetResults();
    setMode(next);
  };

  const acceptPdf = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    resetResults();
    if (file.type !== "application/pdf") {
      setError("請餵我吃 PDF 檔案。");
      return;
    }
    setPdfFile(file);
  };

  const acceptImages = (files: FileList | null) => {
    if (!files) return;
    resetResults();
    const accepted = Array.from(files).filter((file) =>
      ["image/jpeg", "image/png", "image/webp"].includes(file.type),
    );
    if (!accepted.length) {
      setError("請餵我吃 JPG、PNG 或 WebP 圖片。");
      return;
    }
    setImageFiles(accepted);
  };

  const compressPdf = async () => {
    if (!pdfFile) return;
    resetResults();
    setBusy(true);
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      const source = await pdfFile.arrayBuffer();
      const sourcePdf = await pdfjs.getDocument({ data: source }).promise;
      const output = await PDFDocument.create();

      for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
        setProgress(`正在處理第 ${pageNumber} / ${sourcePdf.numPages} 頁`);
        const page = await sourcePdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: pdfScale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("瀏覽器無法建立圖片畫布。");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error("頁面轉換失敗。"))),
            "image/jpeg",
            quality / 100,
          ),
        );
        const embedded = await output.embedJpg(await blob.arrayBuffer());
        const outputPage = output.addPage([viewport.width, viewport.height]);
        outputPage.drawImage(embedded, {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
        });
        page.cleanup();
      }

      setProgress("正在建立壓縮檔案");
      const bytes = await output.save({ useObjectStreams: true });
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      setPdfResult({ url: URL.createObjectURL(blob), size: blob.size });
      setProgress("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PDF 壓縮失敗，請換一個檔案再試。");
    } finally {
      setBusy(false);
    }
  };

  const compressImages = async () => {
    if (!imageFiles.length) return;
    resetResults();
    setBusy(true);
    const results: ImageResult[] = [];
    try {
      for (let index = 0; index < imageFiles.length; index += 1) {
        const file = imageFiles[index];
        setProgress(`正在處理第 ${index + 1} / ${imageFiles.length} 張圖片`);
        const bitmap = await createImageBitmap(file);
        const ratio = Math.min(1, maxWidth / bitmap.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("瀏覽器無法建立圖片畫布。");
        if (format === "image/jpeg") {
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error("圖片轉換失敗。"))),
            format,
            quality / 100,
          ),
        );
        const extension = format.split("/")[1].replace("jpeg", "jpg");
        const baseName = file.name.replace(/\.[^.]+$/, "");
        results.push({
          name: `${baseName}-compressed.${extension}`,
          originalSize: file.size,
          resultSize: blob.size,
          blob,
          url: URL.createObjectURL(blob),
        });
      }
      setImageResults(results);
      setProgress("");
    } catch (reason) {
      results.forEach((item) => URL.revokeObjectURL(item.url));
      setError(reason instanceof Error ? reason.message : "圖片壓縮失敗，請重新嘗試。");
    } finally {
      setBusy(false);
    }
  };

  const downloadAll = async () => {
    const zip = new JSZip();
    imageResults.forEach((item) => zip.file(item.name, item.blob));
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "compressed-images.zip";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const currentFileCount = mode === "pdf" ? (pdfFile ? 1 : 0) : imageFiles.length;
  const canCompress = mode === "pdf" ? Boolean(pdfFile) : imageFiles.length > 0;
  const imageTotal = useMemo(
    () => imageResults.reduce((sum, item) => sum + item.resultSize, 0),
    [imageResults],
  );
  const imageOriginalTotal = useMemo(
    () => imageResults.reduce((sum, item) => sum + item.originalSize, 0),
    [imageResults],
  );

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#" aria-label="減法工具箱首頁">
          <span className="brand-mark">輕</span>
          <span>減法工具箱</span>
        </a>
        <span className="privacy-pill"><span>●</span> 檔案不會離開你的裝置</span>
      </header>

      <section className="hero">
        <div className="eyebrow">PDF & IMAGE COMPRESSOR</div>
        <h1>檔案變輕，<em>品質依然清晰。</em></h1>
        <p>免費壓縮 PDF 與圖片。不用註冊、不用上傳，所有處理都在你的瀏覽器中完成。</p>
      </section>

      <section className="tool-shell" aria-label="檔案壓縮工具">
        <div className="tabs" role="tablist">
          <button className={mode === "pdf" ? "active" : ""} onClick={() => selectMode("pdf")} role="tab" aria-selected={mode === "pdf"}>
            <span className="tab-icon">PDF</span> 壓縮 PDF
          </button>
          <button className={mode === "image" ? "active" : ""} onClick={() => selectMode("image")} role="tab" aria-selected={mode === "image"}>
            <span className="tab-icon image-tab">▧</span> 壓縮圖片
          </button>
        </div>

        <div className="tool-body">
          <div
            className="drop-zone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (mode === "pdf") acceptPdf(event.dataTransfer.files);
              else acceptImages(event.dataTransfer.files);
            }}
          >
            <div className="upload-icon"><UploadIcon /></div>
            <h2>{currentFileCount ? (mode === "pdf" ? pdfFile?.name : `已選擇 ${currentFileCount} 張圖片`) : "拖曳檔案到這裡"}</h2>
            <p>{mode === "pdf" ? "支援單一 PDF 檔案" : "支援 JPG、PNG、WebP，可一次選擇多張"}</p>
            <button className="choose-button" onClick={() => (mode === "pdf" ? pdfInput : imageInput).current?.click()}>
              選擇{mode === "pdf" ? " PDF" : "圖片"}
            </button>
            <input ref={pdfInput} type="file" accept="application/pdf" hidden onChange={(event) => acceptPdf(event.target.files)} />
            <input ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(event) => acceptImages(event.target.files)} />
          </div>

          <div className="settings">
            <div className="setting-row">
              <div>
                <label htmlFor="quality">壓縮品質</label>
                <small>數值越低，產出的檔案容量通常越小</small>
              </div>
              <strong>{quality}%</strong>
              <input id="quality" type="range" min="35" max="92" value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
            </div>

            {mode === "pdf" ? (
              <div className="option-grid">
                <label>頁面解析度
                  <select value={pdfScale} onChange={(event) => setPdfScale(Number(event.target.value))}>
                    <option value="1">輕量（螢幕閱讀）</option>
                    <option value="1.45">標準（建議）</option>
                    <option value="2">清晰（較大）</option>
                  </select>
                </label>
                <div className="notice">文字及向量頁面會轉成圖片，壓縮後可能無法搜尋或選取文字。</div>
              </div>
            ) : (
              <div className="option-grid two-columns">
                <label>最長邊尺寸
                  <select value={maxWidth} onChange={(event) => setMaxWidth(Number(event.target.value))}>
                    <option value="1280">1280 px</option>
                    <option value="1920">1920 px（建議）</option>
                    <option value="2560">2560 px</option>
                    <option value="99999">保留原尺寸</option>
                  </select>
                </label>
                <label>輸出格式
                  <select value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)}>
                    <option value="image/jpeg">JPG</option>
                    <option value="image/webp">WebP</option>
                    <option value="image/png">PNG</option>
                  </select>
                </label>
              </div>
            )}

            {error && <div className="error" role="alert">{error}</div>}
            {progress && <div className="progress"><span className="spinner" />{progress}</div>}
            <button className="primary-button" disabled={!canCompress || busy} onClick={mode === "pdf" ? compressPdf : compressImages}>
              {busy ? "壓縮處理中…" : `開始壓縮${mode === "pdf" ? " PDF" : "圖片"}`}
            </button>
          </div>

          {pdfResult && pdfFile && (
            <div className="result-panel">
              <div>
                <span className="success-check">✓</span>
                <div><strong>壓縮完成</strong><small>{formatBytes(pdfFile.size)} → {formatBytes(pdfResult.size)}，節省 {percentSaved(pdfFile.size, pdfResult.size)}%</small></div>
              </div>
              <a href={pdfResult.url} download={`${pdfFile.name.replace(/\.pdf$/i, "")}-compressed.pdf`}><DownloadIcon />下載 PDF</a>
            </div>
          )}

          {imageResults.length > 0 && (
            <div className="image-results">
              <div className="results-heading">
                <div><strong>{imageResults.length} 張圖片已完成</strong><small>{formatBytes(imageOriginalTotal)} → {formatBytes(imageTotal)}，節省 {percentSaved(imageOriginalTotal, imageTotal)}%</small></div>
                {imageResults.length > 1 && <button onClick={downloadAll}><DownloadIcon />全部打包下載</button>}
              </div>
              <ul>
                {imageResults.map((item) => (
                  <li key={item.name}>
                    <span className="file-dot">✓</span>
                    <span className="file-name">{item.name}</span>
                    <small>{formatBytes(item.originalSize)} → {formatBytes(item.resultSize)}</small>
                    <a href={item.url} download={item.name} aria-label={`下載 ${item.name}`}><DownloadIcon /></a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <section className="trust-row">
        <div><span>⌁</span><strong>100% 本機處理</strong><small>檔案不會上傳至任何伺服器</small></div>
        <div><span>◎</span><strong>免費且免註冊</strong><small>開啟網頁就能立即使用</small></div>
        <div><span>↯</span><strong>快速批次處理</strong><small>一次完成多張圖片壓縮</small></div>
      </section>

      <footer>減法工具箱 · 你的檔案，只有你看得到。</footer>
    </main>
  );
}
