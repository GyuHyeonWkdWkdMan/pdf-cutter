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
    const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
    log(`PDF 로드됨: 총 ${pdf.numPages} 페이지`);

    const pageNums = parsePagesSpec(pagesEl.value, pdf.numPages);
    log(`대상 페이지: ${pageNums.join(', ')}`);

    const cols = Math.max(1, parseInt(colsEl.value, 10) || 3);
    const rows = Math.max(1, parseInt(rowsEl.value, 10) || 8);
    const gutter = Math.max(0, parseInt(gutterEl.value, 10) || 0);
    const skipWhite = !!skipWhiteEl.checked;
    const whiteThresh = Math.min(1, Math.max(0, parseFloat(whiteThreshEl.value) || 0.9995));
    const tilePxH = Math.max(150, parseInt(tilePxHEl.value, 10) || 460);

    // 1) 각 대상 페이지를 고해상도 캔버스에 렌더링
    //    A4 비율 기준. scale은 원하는 타일 높이에 맞춰 동적으로 설정
    const pageTiles = []; // 각 타일의 캔버스 배열을 순서대로 push

    for (const pageNum of pageNums) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const pageRatio = viewport.width / viewport.height; // A4: ~0.707

      // 원하는 타일 높이(tilePxH) 기준으로 전체 페이지 렌더 높이 = tilePxH * rows + gutters
      // gutters는 실제 crop에서만 쓰고 렌더 스케일에는 큰 영향 없음. 간단하게 rows*tilePxH 기준으로 맞춤
      const renderHeight = tilePxH * rows;
      const renderWidth = Math.round(renderHeight * pageRatio);
      const scale = renderHeight / viewport.height;
      const renderViewport = page.getViewport({ scale });

      const pageCanvas = document.createElement('canvas');
      pageCanvas.width = Math.round(renderViewport.width);
      pageCanvas.height = Math.round(renderViewport.height);
      const ctx = pageCanvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

      // 2) 페이지를 cols×rows로 타일링 (좌→우, 상→하)
      const tileWidth = Math.floor(pageCanvas.width / cols);
      const tileHeight = Math.floor(pageCanvas.height / rows);
      let index = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          index++;
          const sx = c * tileWidth + gutter;
          const sy = r * tileHeight + gutter;
          const sw = Math.max(1, tileWidth - gutter * 2);
          const sh = Math.max(1, tileHeight - gutter * 2);

          const tileCanvas = document.createElement('canvas');
          tileCanvas.width = sw;
          tileCanvas.height = sh;
          const tctx = tileCanvas.getContext('2d', { willReadFrequently: true });
          tctx.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

          if (skipWhite) {
            const data = tctx.getImageData(0, 0, sw, sh);
            const whiteRatio = computeWhiteRatio(data, 2);
            if (whiteRatio >= whiteThresh) {
              // 빈 타일로 간주 → 스킵
              continue;
            }
          }

          pageTiles.push(tileCanvas);
        }
      }
      log(`페이지 ${pageNum}: 타일 수 누적 ${pageTiles.length}`);
    }

    assert(pageTiles.length > 0, '유효한 타일이 없습니다. (모두 흰색으로 감지되었을 수 있음)');

    // 3) 1×8 레이아웃으로 PDF 페이지 구성. 각 페이지에는 최대 8개 타일(세로로)
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const outPdf = await PDFDocument.create();

    const tilesPerPage = 8; // 세로 8칸
    const targetW = TARGET_WIDTH; // A4 가로 1/3
    const targetH = TARGET_HEIGHT; // A4 세로 동일

    const tileTargetHeight = targetH / tilesPerPage; // 각 타일의 세로 크기 in PDF points
    const tileTargetWidth = targetW; // 가로는 꽉 채움

    let i = 0;
    let pageIndex = 0;
    while (i < pageTiles.length) {
      pageIndex++;
      const page = outPdf.addPage([targetW, targetH]);

      for (let row = 0; row < tilesPerPage && i < pageTiles.length; row++, i++) {
        const tileCanvas = pageTiles[i];
        // 타일 캔버스를 PNG로 임베드하여 페이지에 배치
        const pngBytes = await new Promise(res => tileCanvas.toBlob(async (blob) => {
          const buf = await blob.arrayBuffer();
          res(new Uint8Array(buf));
        }, 'image/png'));

        const pngEmbed = await outPdf.embedPng(pngBytes);
        const imgAspect = pngEmbed.width / pngEmbed.height;
        const targetAspect = tileTargetWidth / tileTargetHeight;
        let drawW = tileTargetWidth, drawH = tileTargetHeight;
        // 영역 내에 맞추는 contain-fit
        if (imgAspect > targetAspect) {
          // 이미지가 더 가로로 김 → 가로를 영역에 맞추고 세로는 비율에 따라 축소
          drawW = tileTargetWidth;
          drawH = drawW / imgAspect;
        } else {
          // 이미지가 더 세로로 김 → 세로를 영역에 맞추고 가로는 비율에 따라 축소
          drawH = tileTargetHeight;
          drawW = drawH * imgAspect;
        }
        const x = (targetW - drawW) / 2;
        const y = targetH - (row + 1) * tileTargetHeight + (tileTargetHeight - drawH) / 2;
        page.drawImage(pngEmbed, { x, y, width: drawW, height: drawH });
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


