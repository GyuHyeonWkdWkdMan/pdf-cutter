// 여백 맞추기
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
  const skipWhite = skipWhiteEl.checked;
  const whiteThresh = parseFloat(whiteThreshEl.value) || 0.9995;
  const tilePxH = Math.max(150, parseInt(tilePxHEl.value, 10) || 460);

  // PDF.js 문서 로드
  const pdfjsDoc = await pdfjsLib.getDocument({ data: arrayBuf }).promise;

  let refOffset = null; // 첫 타일 기준 바코드 위치 및 scale

  for (const pageNum of pageNums) {
    const srcPage = await pdfjsDoc.getPage(pageNum);
    const viewport = srcPage.getViewport({ scale: 1 });
    const srcW = viewport.width;
    const srcH = viewport.height;

    const tileWidth = srcW / cols;
    const tileHeight = srcH / rows;

    // pdf-lib에서 임베드
    const [srcEmbed] = await outPdf.embedPages([srcPdf.getPage(pageNum - 1)]);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let isWhite = false;
        let dx = 0, dy = 0;

        const needCanvas = skipWhite || !refOffset;
        if (needCanvas) {
          const scale = tilePxH / tileHeight;
          const tileViewport = srcPage.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = tileWidth * scale;
          canvas.height = tileHeight * scale;
          const ctx = canvas.getContext('2d');

          await srcPage.render({
            canvasContext: ctx,
            viewport: tileViewport,
            transform: [1,0,0,1, -c*tileWidth*scale, -r*tileHeight*scale]
          }).promise;

          // 흰 타일 판단
          if (skipWhite) {
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let whiteCount = 0;
            for (let i = 0; i < imgData.data.length; i += 4) {
              const r1 = imgData.data[i], g1 = imgData.data[i+1], b1 = imgData.data[i+2];
              if (r1 >= 250 && g1 >= 250 && b1 >= 250) whiteCount++;
            }
            const whiteRatio = whiteCount / (canvas.width * canvas.height);
            if (whiteRatio >= whiteThresh) { isWhite = true; }
          }

          // 첫 타일 기준 바코드 위치 추출
          if (!refOffset) {
            await new Promise((resolve) => {
              Quagga.decodeSingle({
                src: canvas.toDataURL(),
                numOfWorkers: 0,
                inputStream: { size: 800 },
                decoder: { readers: ["code_128_reader","ean_reader","ean_8_reader"] }
              }, function(result){
                if(result && result.box) {
                  const box = result.box;
                  const bx = (box[0][0]+box[1][0]+box[2][0]+box[3][0])/4;
                  const by = (box[0][1]+box[1][1]+box[2][1]+box[3][1])/4;
                  refOffset = { bx, by, scale };
                }
                resolve();
              });
            });
          } else {
            // 나머지 타일 바코드 위치 보정
            const scale = refOffset.scale;
            const canvasCheck = document.createElement('canvas');
            canvasCheck.width = tileWidth * scale;
            canvasCheck.height = tileHeight * scale;
            const ctxCheck = canvasCheck.getContext('2d');
            await srcPage.render({
              canvasContext: ctxCheck,
              viewport: srcPage.getViewport({ scale }),
              transform: [1,0,0,1, -c*tileWidth*scale, -r*tileHeight*scale]
            }).promise;

            await new Promise((resolve) => {
              Quagga.decodeSingle({
                src: canvasCheck.toDataURL(),
                numOfWorkers: 0,
                inputStream: { size: 800 },
                decoder: { readers: ["code_128_reader","ean_reader","ean_8_reader"] }
              }, function(result){
                if(result && result.box) {
                  const box = result.box;
                  const cx = (box[0][0]+box[1][0]+box[2][0]+box[3][0])/4;
                  const cy = (box[0][1]+box[1][1]+box[2][1]+box[3][1])/4;

                  // 여백 줄이는 factor 적용
                  const factor = 0.14; // 0~1, 작을수록 여백 감소
                  const factor2 = -0.1; // 0~1, 작을수록 여백 감소
                  dx = (refOffset.bx - cx) * factor;
                  dy = (refOffset.by - cy) * factor2;
                }
                resolve();
              });
            });
          }
        }

        if (!isWhite) {
          const page = outPdf.addPage([tileWidth, tileHeight]);
          page.drawPage(srcEmbed, {
            x: -c * tileWidth + dx,
            y: -(rows - 1 - r) * tileHeight + dy,
            width: srcW,
            height: srcH
          });
        }
      }
    }
    log(`페이지 ${pageNum}: 타일 처리 완료`);
  }

  const outBytes = await outPdf.save();
  const blob = new Blob([outBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  downloadA.href = url;
  downloadA.style.display = 'inline-flex';
  log(`완료: 결과 페이지 수 ${outPdf.getPageCount()}`);
}

})();
