# PDF layout service (server.mjs: PyMuPDF extraction + headless Chromium export). Build from the repository root:
#   docker build -f services/pdf-layout/Dockerfile .      (deploy/pdf-layout/docker-compose.yml does this)
# An exact Node release, so a rebuild months later runs what CI tested; raise it on purpose.
FROM node:22.23.3-bookworm-slim
ENV NODE_ENV=production PYTHONDONTWRITEBYTECODE=1
# MuPDF inside the PyMuPDF wheel has its own Tesseract and only needs language data (below): no tesseract-ocr packages.
# Debian versions stay unpinned: the archive drops superseded versions, and a pinned build would then fail. A plain
# rebuild reuses this layer from the cache, so security updates only arrive with --pull --no-cache (README A.5).
# Fonts: exports and the preview set Vietnamese in Liberation Serif, which has the widths of the Times New Roman every
# fit was tuned with (engine.mjs fontPath); DejaVu Serif fills in symbols it lacks; Noto CJK draws Chinese.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv chromium fonts-liberation2 fonts-dejavu-core fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime packages without install scripts: the service only needs puppeteer-core and the OCR language data.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY services/pdf-layout/requirements.txt ./services/pdf-layout/requirements.txt
RUN python3 -m venv /opt/pdf-venv && /opt/pdf-venv/bin/pip install --no-cache-dir --disable-pip-version-check -r services/pdf-layout/requirements.txt
COPY services/pdf-layout ./services/pdf-layout
COPY frontend/pdf-box-layout.js ./frontend/pdf-box-layout.js
COPY frontend/math-text.js ./frontend/math-text.js
# The OCR models that npm test, npm run setup and the Windows measurements use (@tesseract.js-data 4.0.0_best_int,
# the files backend/vendor.mjs copies), minus the config lines that only print warnings (see tessdata.mjs). Debian's
# tesseract-ocr-* packages ship different models, so OCR in production would not be the OCR that was tested.
RUN mkdir /tmp/tessdata && for lang in chi_sim eng; do gzip -dc "node_modules/@tesseract.js-data/$lang/4.0.0_best_int/$lang.traineddata.gz" > "/tmp/tessdata/$lang.traineddata"; done && node services/pdf-layout/prepare-ocr.mjs --from /tmp/tessdata --to /opt/tessdata && rm -rf /tmp/tessdata
ENV PDF_PYTHON=/opt/pdf-venv/bin/python CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium PDF_LAYOUT_HOST=0.0.0.0 PDF_CHROMIUM_NO_SANDBOX=1 TESSDATA_PREFIX=/opt/tessdata
# The build stops here if exports would not use Liberation Serif (a base image without fonts-liberation2).
RUN node -e "import('./services/pdf-layout/engine.mjs').then(({fontPath})=>{const path=fontPath();console.log('PDF font: '+path);if(!path.endsWith('/LiberationSerif-Regular.ttf'))process.exit(1);})"
# Uploaded PDFs are parsed by native code: run without root (Chromium still needs --no-sandbox inside a container).
USER node
EXPOSE 8091
# /health needs the token too, so the check runs inside the container with the container's own environment. After
# 4 failures in a row it stops the service so that the restart policy starts a fresh one (healthcheck.mjs).
HEALTHCHECK --interval=15s --timeout=10s --start-period=30s --retries=3 CMD ["node","services/pdf-layout/healthcheck.mjs","/health","PDF_LAYOUT_SERVICE_TOKEN"]
CMD ["node", "services/pdf-layout/server.mjs"]
