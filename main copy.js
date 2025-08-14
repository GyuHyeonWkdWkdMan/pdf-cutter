// Core logic for: A4 PDF 특정 페이지 → 3x8 타일 → 흰 타일 제외 → 1x8 레이아웃 PDF (최대 3페이지)
// 브라우저 전용, 서버 불필요

(function () {
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

  const A4_POINTS = { width: 595.28, height: 841.89 }; // 72dpi 기준 (approx)
  const TARGET_WIDTH = A4_POINTS.width / 3; // 가로 A4 1/3
  const TARGET_HEIGHT = A4_POINTS.height;   // 세로 A4 동일

  function log(msg) {
    console.log(msg);
    if (logEl) {
      logEl.textContent += (typeof msg === 'string' ? msg : JSON.stringify(msg)) + '\n';
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

  function computeWhiteRatio(imageData, sampleStride = 1) {
    const data = imageData.data;
    let whiteCount = 0;
    let count = 0;
    for (let y = 0; y < imageData.height; y += sampleStride) {
      for (let x = 0; x < imageData.width; x += sampleStride) {
        const idx = (y * imageData.width + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
        // 투명 픽셀은 흰색으로 취급하지 않음
        if (a === 0) { count++; continue; }
        // 미세한 회색(스캔 노이즈) 보존: 250 대신 252로 상향
        if (r >= 252 && g >= 252 && b >= 252) whiteCount++;
        count++;
      }
    }
    return count > 0 ? whiteCount / count : 1;
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
  }

  function enableRunIfReady() {
    runBtn.disabled = !fileEl.files?.[0];
  }

  fileEl.addEventListener('change', () => {
    logEl.textContent = '';
    enableRunIfReady();
  });

  runBtn.addEventListener('click', async () => {
    try {
      downloadA.style.display = 'none';
      downloadA.removeAttribute('href');
      runBtn.disabled = true;
      await process();
    } catch (err) {
      console.error(err);
      log('에러: ' + (err?.message || err));
    } finally {
      runBtn.disabled = false;
    }
  });

async function process() {
  assert(fileEl.files?.[0], 'PDF 파일을 선택하세요.');
  const file = fileEl.files[0];
  const arrayBuf = await file.arrayBuffer();

  logEl.textContent = '';

  const srcPdf = await PDFLib.PDFDocument.load(arrayBuf);
  log(`PDF 로드됨: 총 ${srcPdf.getPageCount()} 페이지`);

  const pageNums = parsePagesSpec(pagesEl.value, srcPdf.getPageCount());
  log(`대상 페이지: ${pageNums.join(', ')}`);

  const cols = Math.max(1, parseInt(colsEl.value, 10) || 3);
  const rows = Math.max(1, parseInt(rowsEl.value, 10) || 8);

  const outPdf = await PDFLib.PDFDocument.create();
  const TARGET_WIDTH = PDFLib.PageSizes.A4[0] / 3; // 가로 A4 1/3
  const TARGET_HEIGHT = PDFLib.PageSizes.A4[1];    // 세로 A4
  const tilesPerPage = 8; // 1x8 레이아웃

  // 1) 각 페이지를 cols×rows로 나누어 tile 배열 생성
  const tiles = [];
  for (const pageNum of pageNums) {
    const srcPage = srcPdf.getPage(pageNum - 1);
    const { width: pw, height: ph } = srcPage.getSize();
    const tileW = pw / cols;
    const tileH = ph / rows;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * tileW;
        const y = ph - (r + 1) * tileH; // PDF 좌표계 아래쪽이 0
        tiles.push({ page: srcPage, x, y, w: tileW, h: tileH });
      }
    }
  }

  assert(tiles.length > 0, '유효한 타일이 없습니다.');

  // 2) 1x8 레이아웃 PDF 생성
  let i = 0;
  while (i < tiles.length) {
    const page = outPdf.addPage([TARGET_WIDTH, TARGET_HEIGHT]);
    const tileHeightPDF = TARGET_HEIGHT / tilesPerPage;

    for (let row = 0; row < tilesPerPage && i < tiles.length; row++, i++) {
      const t = tiles[i];

      const [embedded] = await outPdf.embedPages([t.page]);

      // tile 영역 대비 1x8 영역 scale 계산
      const scaleX = TARGET_WIDTH / t.w;
      const scaleY = tileHeightPDF / t.h;
      const scale = Math.min(scaleX, scaleY);

      const dx = -t.x * scale;
      const dy = TARGET_HEIGHT - (row + 1) * tileHeightPDF - t.y * scale + tileHeightPDF;

      page.drawPage(embedded, {
        x: dx,
        y: dy,
        xScale: scale,
        yScale: scale
      });
    }
  }

  const outBytes = await outPdf.save();
  const blob = new Blob([outBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  downloadA.href = url;
  downloadA.style.display = 'inline-flex';
  log(`완료: 결과 페이지 수 ${outPdf.getPageCount()}`);
}

})();

