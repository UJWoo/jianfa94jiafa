"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import "./styles.css";

type Mode = "pdf" | "image" | "merge";
type ImageFormat = "original" | "image/jpeg" | "image/webp" | "image/png";
type CompressionPreset = "light" | "standard" | "strong" | "custom";
type BlankPageMode = "a4-portrait" | "a4-landscape" | "previous" | "next";

type MergePdfItem = {
  id: string;
  kind: "pdf";
  file: File;
  pageCount: number;
};

type MergeBlankItem = {
  id: string;
  kind: "blank";
  sizeMode: BlankPageMode;
};

type MergeItem = MergePdfItem | MergeBlankItem;

type ImageResult = {
  name: string;
  originalSize: number;
  resultSize: number;
  originalWidth: number;
  originalHeight: number;
  outputWidth: number;
  outputHeight: number;
  keptOriginal: boolean;
  url: string;
  blob: Blob;
};

type LoadedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
};

const imageExtensions = ["jpg", "jpeg", "png", "webp", "heic", "heif"];

const getExtension = (name: string) =>
  name.toLowerCase().split(".").pop() ?? "";

const isSupportedImage = (file: File) =>
  file.type.startsWith("image/") || imageExtensions.includes(getExtension(file.name));

const isHeicImage = (file: File) =>
  ["image/heic", "image/heif"].includes(file.type.toLowerCase()) ||
  ["heic", "heif"].includes(getExtension(file.name));

const getOriginalOutputFormat = (file: File): Exclude<ImageFormat, "original"> => {
  if (["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    return file.type as Exclude<ImageFormat, "original">;
  }
  const extension = getExtension(file.name);
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
};

const loadImage = async (file: File): Promise<LoadedImage> => {
  let sourceBlob: Blob = file;

  if (isHeicImage(file)) {
    const { default: heic2any } = await import("heic2any");
    const converted = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.92,
    });
    sourceBlob = Array.isArray(converted) ? converted[0] : converted;
  }

  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(sourceBlob, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch {
      // Safari and a few mobile image encoders need the HTMLImageElement fallback.
    }
  }

  const url = URL.createObjectURL(sourceBlob);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(`無法讀取「${file.name}」。請確認檔案未損壞，或先轉為 JPG／PNG。`);
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    cleanup: () => URL.revokeObjectURL(url),
  };
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
  const [maxWidth, setMaxWidth] = useState(99999);
  const [format, setFormat] = useState<ImageFormat>("original");
  const [preset, setPreset] = useState<CompressionPreset>("light");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [pdfResult, setPdfResult] = useState<{ url: string; size: number } | null>(null);
  const [imageResults, setImageResults] = useState<ImageResult[]>([]);
  const [mergeItems, setMergeItems] = useState<MergeItem[]>([]);
  const [blankPageMode, setBlankPageMode] = useState<BlankPageMode>("a4-portrait");
  const [mergeFileName, setMergeFileName] = useState("merged-document.pdf");
  const [mergeResult, setMergeResult] = useState<{ url: string; size: number; pageCount: number } | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);

  const resetResults = useCallback(() => {
    if (pdfResult) URL.revokeObjectURL(pdfResult.url);
    if (mergeResult) URL.revokeObjectURL(mergeResult.url);
    imageResults.forEach((item) => URL.revokeObjectURL(item.url));
    setPdfResult(null);
    setMergeResult(null);
    setImageResults([]);
    setError("");
    setProgress("");
  }, [pdfResult, mergeResult, imageResults]);

  const selectMode = (next: Mode) => {
    resetResults();
    setMode(next);
    if (next === "image") {
      setPreset("light");
      setQuality(92);
      setMaxWidth(99999);
      setFormat("original");
    } else {
      setQuality(72);
    }
  };

  const acceptPdf = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    resetResults();
    if (file.type !== "application/pdf") {
      setError("請選擇 PDF 檔案。");
      return;
    }
    setPdfFile(file);
  };

  const acceptImages = (files: FileList | null) => {
    if (!files) return;
    resetResults();
    const selected = Array.from(files);
    const accepted = selected.filter(isSupportedImage);
    if (!accepted.length) {
      setImageFiles([]);
      setError("沒有可處理的圖片。支援 JPG、PNG、WebP、HEIC 與 HEIF。");
      return;
    }
    setImageFiles(accepted);
    if (accepted.length !== selected.length) {
      setError(`已略過 ${selected.length - accepted.length} 個不支援的檔案。`);
    }
  };

  const applyPreset = (next: Exclude<CompressionPreset, "custom">) => {
    setPreset(next);
    setFormat("original");
    if (next === "light") {
      setQuality(92);
      setMaxWidth(99999);
    } else if (next === "standard") {
      setQuality(85);
      setMaxWidth(2560);
    } else {
      setQuality(72);
      setMaxWidth(1920);
    }
  };

  const acceptMergePdfs = async (files: FileList | null) => {
    if (!files?.length) return;
    resetResults();
    setBusy(true);
    const nextItems: MergePdfItem[] = [];
    const selected = Array.from(files).filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const file = selected[index];
        setProgress(`正在讀取第 ${index + 1} / ${selected.length} 份 PDF`);
        try {
          const document = await PDFDocument.load(await file.arrayBuffer());
          nextItems.push({
            id: crypto.randomUUID(),
            kind: "pdf",
            file,
            pageCount: document.getPageCount(),
          });
        } catch {
          setError(`無法讀取「${file.name}」，檔案可能已加密或損壞。`);
        }
      }
      setMergeItems((current) => [...current, ...nextItems]);
      if (!selected.length) setError("請選擇 PDF 檔案。");
    } finally {
      setProgress("");
      setBusy(false);
    }
  };

  const insertBlankPage = (index: number) => {
    resetResults();
    setMergeItems((current) => {
      const next = [...current];
      next.splice(index, 0, {
        id: crypto.randomUUID(),
        kind: "blank",
        sizeMode: blankPageMode,
      });
      return next;
    });
  };

  const removeMergeItem = (id: string) => {
    resetResults();
    setMergeItems((current) => current.filter((item) => item.id !== id));
  };

  const moveMergeItem = (id: string, direction: -1 | 1) => {
    resetResults();
    setMergeItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const dropMergeItem = (targetId: string) => {
    if (!draggedItemId || draggedItemId === targetId) return;
    resetResults();
    setMergeItems((current) => {
      const from = current.findIndex((item) => item.id === draggedItemId);
      const to = current.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDraggedItemId(null);
  };

  const mergePdfs = async () => {
    if (!mergeItems.some((item) => item.kind === "pdf")) return;
    resetResults();
    setBusy(true);
    const loadedDocuments = new Map<string, PDFDocument>();
    try {
      const pdfItems = mergeItems.filter((item): item is MergePdfItem => item.kind === "pdf");
      for (let index = 0; index < pdfItems.length; index += 1) {
        const item = pdfItems[index];
        setProgress(`正在載入第 ${index + 1} / ${pdfItems.length} 份 PDF`);
        try {
          loadedDocuments.set(item.id, await PDFDocument.load(await item.file.arrayBuffer()));
        } catch {
          throw new Error(`無法合併「${item.file.name}」，檔案可能已加密或損壞。`);
        }
      }

      const output = await PDFDocument.create();
      let lastPageSize: { width: number; height: number } | null = null;

      for (let index = 0; index < mergeItems.length; index += 1) {
        const item = mergeItems[index];
        setProgress(`正在合併第 ${index + 1} / ${mergeItems.length} 個項目`);
        if (item.kind === "pdf") {
          const source = loadedDocuments.get(item.id);
          if (!source) continue;
          const copiedPages = await output.copyPages(source, source.getPageIndices());
          copiedPages.forEach((page) => {
            output.addPage(page);
            lastPageSize = page.getSize();
          });
          continue;
        }

        let pageSize = { width: 595.28, height: 841.89 };
        if (item.sizeMode === "a4-landscape") {
          pageSize = { width: 841.89, height: 595.28 };
        } else if (item.sizeMode === "previous" && lastPageSize) {
          pageSize = lastPageSize;
        } else if (item.sizeMode === "next") {
          const nextPdf = mergeItems
            .slice(index + 1)
            .find((candidate): candidate is MergePdfItem => candidate.kind === "pdf");
          const nextDocument = nextPdf ? loadedDocuments.get(nextPdf.id) : null;
          if (nextDocument?.getPageCount()) pageSize = nextDocument.getPage(0).getSize();
          else if (lastPageSize) pageSize = lastPageSize;
        }
        output.addPage([pageSize.width, pageSize.height]);
        lastPageSize = pageSize;
      }

      setProgress("正在建立合併檔案");
      const bytes = await output.save({ useObjectStreams: true });
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      setMergeResult({
        url: URL.createObjectURL(blob),
        size: blob.size,
        pageCount: output.getPageCount(),
      });
      setProgress("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "PDF 合併失敗，請重新嘗試。");
    } finally {
      setBusy(false);
    }
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
        const loaded = await loadImage(file);
        const ratio = Math.min(1, maxWidth / loaded.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(loaded.width * ratio));
        canvas.height = Math.max(1, Math.round(loaded.height * ratio));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("瀏覽器無法建立圖片畫布。");
        const outputFormat = format === "original" ? getOriginalOutputFormat(file) : format;
        if (outputFormat === "image/jpeg") {
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(loaded.source, 0, 0, canvas.width, canvas.height);
        loaded.cleanup();
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(new Error("圖片轉換失敗。"))),
            outputFormat,
            quality / 100,
          ),
        );
        const keptOriginal = blob.size >= file.size;
        const resultBlob = keptOriginal ? file : blob;
        const extension = outputFormat.split("/")[1].replace("jpeg", "jpg");
        const baseName = file.name.replace(/\.[^.]+$/, "");
        results.push({
          name: keptOriginal ? file.name : `${baseName}-compressed.${extension}`,
          originalSize: file.size,
          resultSize: resultBlob.size,
          originalWidth: loaded.width,
          originalHeight: loaded.height,
          outputWidth: keptOriginal ? loaded.width : canvas.width,
          outputHeight: keptOriginal ? loaded.height : canvas.height,
          keptOriginal,
          blob: resultBlob,
          url: URL.createObjectURL(resultBlob),
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
  const mergePageCount = useMemo(
    () => mergeItems.reduce(
      (sum, item) => sum + (item.kind === "pdf" ? item.pageCount : 1),
      0,
    ),
    [mergeItems],
  );
  const normalizedMergeFileName = `${mergeFileName.trim().replace(/\.pdf$/i, "") || "merged-document"}.pdf`;

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#" aria-label="輕壓工具箱首頁">
          <span className="brand-mark">輕</span>
          <span>輕壓工具箱</span>
        </a>
        <span className="privacy-pill"><span>●</span> 檔案不會離開你的裝置</span>
      </header>

      <section className="hero">
        <div className="eyebrow">PDF & IMAGE TOOLBOX</div>
        <h1>檔案變輕，<em>品質依然清晰。</em></h1>
        <p>免費壓縮圖片與 PDF，也能合併多份 PDF。不用註冊、不用上傳，所有處理都在你的瀏覽器中完成。</p>
      </section>

      <section className="tool-shell" aria-label="檔案壓縮工具">
        <div className="tabs" role="tablist">
          <button className={mode === "pdf" ? "active" : ""} onClick={() => selectMode("pdf")} role="tab" aria-selected={mode === "pdf"}>
            <span className="tab-icon">PDF</span> 壓縮 PDF
          </button>
          <button className={mode === "image" ? "active" : ""} onClick={() => selectMode("image")} role="tab" aria-selected={mode === "image"}>
            <span className="tab-icon image-tab">▧</span> 壓縮圖片
          </button>
          <button className={mode === "merge" ? "active" : ""} onClick={() => selectMode("merge")} role="tab" aria-selected={mode === "merge"}>
            <span className="tab-icon merge-tab">＋</span> 合併 PDF
          </button>
        </div>

        <div className="tool-body">
          {mode === "merge" ? (
            <div className="merge-tool">
              <div
                className="merge-upload"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void acceptMergePdfs(event.dataTransfer.files);
                }}
              >
                <div>
                  <strong>加入要合併的 PDF</strong>
                  <small>可一次選擇多份，也能稍後繼續加入</small>
                </div>
                <button className="choose-button" onClick={() => mergeInput.current?.click()}>
                  ＋ 選擇 PDF
                </button>
                <input
                  ref={mergeInput}
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  hidden
                  onChange={(event) => {
                    void acceptMergePdfs(event.target.files);
                    event.currentTarget.value = "";
                  }}
                />
              </div>

              <div className="blank-settings">
                <label>
                  空白頁尺寸
                  <select value={blankPageMode} onChange={(event) => setBlankPageMode(event.target.value as BlankPageMode)}>
                    <option value="a4-portrait">A4 直式</option>
                    <option value="a4-landscape">A4 橫式</option>
                    <option value="previous">沿用前一頁尺寸</option>
                    <option value="next">沿用下一頁尺寸</option>
                  </select>
                </label>
                <button onClick={() => insertBlankPage(mergeItems.length)}>＋ 在最後插入空白頁</button>
              </div>

              {mergeItems.length === 0 ? (
                <div className="merge-empty">
                  <span>PDF</span>
                  <strong>尚未加入合併項目</strong>
                  <small>加入至少一份 PDF 後，即可排序並插入空白頁。</small>
                </div>
              ) : (
                <>
                  <div className="merge-list-heading">
                    <div>
                      <strong>合併順序</strong>
                      <small>拖曳項目，或使用箭頭調整順序</small>
                    </div>
                    <button onClick={() => {
                      resetResults();
                      setMergeItems([]);
                    }}>全部清除</button>
                  </div>
                  <div className="merge-sequence">
                    <button className="insert-blank" onClick={() => insertBlankPage(0)}>＋ 在此插入空白頁</button>
                    {mergeItems.map((item, index) => (
                      <div key={item.id}>
                        <article
                          className={`merge-item ${item.kind === "blank" ? "blank-item" : ""}`}
                          draggable
                          onDragStart={() => setDraggedItemId(item.id)}
                          onDragEnd={() => setDraggedItemId(null)}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={() => dropMergeItem(item.id)}
                        >
                          <span className="drag-handle" aria-hidden="true">⠿</span>
                          <span className="merge-type">{item.kind === "pdf" ? "PDF" : "空白"}</span>
                          <div className="merge-details">
                            <strong>{item.kind === "pdf" ? item.file.name : "空白頁"}</strong>
                            <small>
                              {item.kind === "pdf"
                                ? `${item.pageCount} 頁 · ${formatBytes(item.file.size)}`
                                : item.sizeMode === "a4-portrait"
                                  ? "A4 直式"
                                  : item.sizeMode === "a4-landscape"
                                    ? "A4 橫式"
                                    : item.sizeMode === "previous"
                                      ? "沿用前一頁尺寸"
                                      : "沿用下一頁尺寸"}
                            </small>
                          </div>
                          <div className="merge-actions">
                            <button disabled={index === 0} onClick={() => moveMergeItem(item.id, -1)} aria-label="向上移動">↑</button>
                            <button disabled={index === mergeItems.length - 1} onClick={() => moveMergeItem(item.id, 1)} aria-label="向下移動">↓</button>
                            <button className="remove-button" onClick={() => removeMergeItem(item.id)} aria-label="刪除項目">×</button>
                          </div>
                        </article>
                        <button className="insert-blank" onClick={() => insertBlankPage(index + 1)}>＋ 在此插入空白頁</button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="merge-output">
                <label>
                  輸出檔名
                  <input
                    value={mergeFileName}
                    onChange={(event) => setMergeFileName(event.target.value)}
                    placeholder="merged-document.pdf"
                  />
                </label>
                <div className="merge-summary">
                  <span>{mergeItems.filter((item) => item.kind === "pdf").length} 份 PDF</span>
                  <span>{mergeItems.filter((item) => item.kind === "blank").length} 張空白頁</span>
                  <strong>共 {mergePageCount} 頁</strong>
                </div>
              </div>

              {error && <div className="error" role="alert">{error}</div>}
              {progress && <div className="progress"><span className="spinner" />{progress}</div>}
              <button
                className="primary-button"
                disabled={busy || !mergeItems.some((item) => item.kind === "pdf")}
                onClick={mergePdfs}
              >
                {busy ? "合併處理中…" : "合併並建立 PDF"}
              </button>

              {mergeResult && (
                <div className="result-panel">
                  <div>
                    <span className="success-check">✓</span>
                    <div>
                      <strong>PDF 合併完成</strong>
                      <small>{mergeResult.pageCount} 頁 · {formatBytes(mergeResult.size)}</small>
                    </div>
                  </div>
                  <a href={mergeResult.url} download={normalizedMergeFileName}><DownloadIcon />下載合併 PDF</a>
                </div>
              )}
            </div>
          ) : (
            <>
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
            <p>{mode === "pdf" ? "支援單一 PDF 檔案" : "支援 JPG、PNG、WebP、HEIC，可一次選擇多張"}</p>
            <button className="choose-button" onClick={() => (mode === "pdf" ? pdfInput : imageInput).current?.click()}>
              選擇{mode === "pdf" ? " PDF" : "圖片"}
            </button>
            <input ref={pdfInput} type="file" accept="application/pdf" hidden onChange={(event) => acceptPdf(event.target.files)} />
            <input
              ref={imageInput}
              type="file"
              accept="image/*,.jpg,.jpeg,.png,.webp,.heic,.heif"
              multiple
              hidden
              onChange={(event) => {
                acceptImages(event.target.files);
                event.currentTarget.value = "";
              }}
            />
          </div>

          <div className="settings">
            {mode === "image" && (
              <div className="preset-section">
                <div className="preset-heading">
                  <div>
                    <strong>壓縮模式</strong>
                    <small>輕度壓縮會保留原始解析度</small>
                  </div>
                  {preset === "custom" && <span>自訂設定</span>}
                </div>
                <div className="preset-grid">
                  <button className={preset === "light" ? "active" : ""} onClick={() => applyPreset("light")}>
                    <strong>輕度</strong><small>原尺寸 · 92%</small>
                  </button>
                  <button className={preset === "standard" ? "active" : ""} onClick={() => applyPreset("standard")}>
                    <strong>標準</strong><small>2560 px · 85%</small>
                  </button>
                  <button className={preset === "strong" ? "active" : ""} onClick={() => applyPreset("strong")}>
                    <strong>高度</strong><small>1920 px · 72%</small>
                  </button>
                </div>
              </div>
            )}
            <div className="setting-row">
              <div>
                <label htmlFor="quality">壓縮品質</label>
                <small>數值越低，檔案通常越小</small>
              </div>
              <strong>{quality}%</strong>
              <input
                id="quality"
                type="range"
                min={mode === "pdf" ? "35" : "50"}
                max={mode === "pdf" ? "92" : "100"}
                value={quality}
                onChange={(event) => {
                  setQuality(Number(event.target.value));
                  if (mode === "image") setPreset("custom");
                }}
              />
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
                  <select value={maxWidth} onChange={(event) => {
                    setMaxWidth(Number(event.target.value));
                    setPreset("custom");
                  }}>
                    <option value="99999">保留原尺寸（建議）</option>
                    <option value="1280">1280 px</option>
                    <option value="1920">1920 px</option>
                    <option value="2560">2560 px</option>
                  </select>
                </label>
                <label>輸出格式
                  <select value={format} onChange={(event) => {
                    setFormat(event.target.value as ImageFormat);
                    setPreset("custom");
                  }}>
                    <option value="original">與原檔相同（建議）</option>
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
                    <small>
                      {item.originalWidth} × {item.originalHeight} → {item.outputWidth} × {item.outputHeight}
                      <br />
                      {item.keptOriginal
                        ? `原檔已較精簡，保留 ${formatBytes(item.originalSize)}`
                        : `${formatBytes(item.originalSize)} → ${formatBytes(item.resultSize)}`}
                    </small>
                    <a href={item.url} download={item.name} aria-label={`下載 ${item.name}`}><DownloadIcon /></a>
                  </li>
                ))}
              </ul>
            </div>
          )}
            </>
          )}
        </div>
      </section>

      <section className="trust-row">
        <div><span>⌁</span><strong>100% 本機處理</strong><small>檔案不會上傳至任何伺服器</small></div>
        <div><span>◎</span><strong>免費且免註冊</strong><small>開啟網頁就能立即使用</small></div>
        <div><span>↯</span><strong>快速批次處理</strong><small>一次完成多張圖片壓縮</small></div>
      </section>

      <footer>輕壓工具箱 · 你的檔案，只有你看得到。</footer>
    </main>
  );
}
