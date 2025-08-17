// 한개씩 짤려서 세로 정렬
(async function () {
  const logEl = document.getElementById('log');
  const fileEl = document.getElementById('file');
  const runBtn = document.getElementById('run');
  const downloadA = document.getElementById('download');
  const pagesEl = document.getElementById('pages');
  const colsEl = document.getElementById('cols');
  const rowsEl = document.getElementById('rows');
  const gutterEl = document.getElementById('gutter');
  const skipWhiteEl = document.getElementById('skipWhite');
  const whiteThreshEl = document.getElementById('whiteThresh');
  const tilePxHEl = document.getElementById('tilePxH');

  function log(msg) {
    if (logEl) {
      logEl.textContent += msg + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function parsePagesSpec(spec, total) {
    if (!spec || !spec.trim()) return [1];
    const out = new Set();
    const parts = spec.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(n => parseInt(n.trim(), 10));
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const start = Math.max(1, Math.min(a, b));
        const end = Math.min(total ?? b, Math.max(a, b));
        for (let p = start; p <= end; p++) out.add(p);
      } else {
        const p = parseInt(part, 10);
        if (Number.isFinite(p) && p >= 1) out.add(p);
      }
    }
    return [...out].sort((x, y) => x - y);
  }

  function enableRunIfReady() {
    runBtn.disabled = !fileEl.files?.[0];
  }

  fileEl.addEventListener('change', () => {
    logEl.textContent = '';
    enableRunIfReady();
  });

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    downloadA.style.display = 'none';
    downloadA.removeAttribute('href');
    try {
      await process();
    } catch (err) {
      log('에러: ' + (err?.message || err));
    } finally {
      runBtn.disabled = false;
    }
  });

  async function process() {
    if (!fileEl.files?.[0]) throw new Error('PDF 파일을 선택하세요.');
    const file = fileEl.files[0];
    const arrayBuf = await file.arrayBuffer();

    const { PDFDocument } = PDFLib;
    const srcPdf = await PDFDocument.load(arrayBuf);
    const outPdf = await PDFDocument.create();

    const pageNums = parsePagesSpec(pagesEl.value, srcPdf.getPageCount());
    log(`대상 페이지: ${pageNums.join(', ')}`);

    const cols = Math.max(1, parseInt(colsEl.value, 10) || 3);
    const rows = Math.max(1, parseInt(rowsEl.value, 10) || 8);
    const gutter = Math.max(0, parseInt(gutterEl.value, 10) || 0);

    for (const pageNum of pageNums) {
      const [srcPage] = await outPdf.embedPages([srcPdf.getPage(pageNum - 1)]);
      const { width: srcW, height: srcH } = srcPage.size();

      const tileWidth = srcW / cols;
      const tileHeight = srcH / rows;

      // **가로 → 세로(row-major) 순서로 타일 생성**
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const page = outPdf.addPage([tileWidth, tileHeight]);
          page.drawPage(srcPage, {
            x: -c * tileWidth,
            y: - (rows - 1 - r) * tileHeight, // PDF 좌표계 아래쪽이 0
            width: srcW,
            height: srcH
          });
        }
      }
      log(`페이지 ${pageNum}: ${cols * rows}개 타일 생성`);
    }

    const outBytes = await outPdf.save();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    downloadA.href = url;
    downloadA.style.display = 'inline-flex';
    log(`완료: 결과 페이지 수 ${outPdf.getPageCount()}`);
  }
})();
