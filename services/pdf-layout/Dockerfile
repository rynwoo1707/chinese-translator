FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv chromium fonts-dejavu-core fonts-noto-cjk tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY services/pdf-layout/requirements.txt ./services/pdf-layout/requirements.txt
RUN python3 -m venv /opt/pdf-venv && /opt/pdf-venv/bin/pip install --no-cache-dir -r services/pdf-layout/requirements.txt
COPY services/pdf-layout ./services/pdf-layout
COPY frontend/pdf-box-layout.js ./frontend/pdf-box-layout.js
COPY frontend/math-text.js ./frontend/math-text.js
# Same OCR models as the distribution package, minus the config lines that only print warnings (see tessdata.mjs).
RUN node services/pdf-layout/prepare-ocr.mjs --from /usr/share/tesseract-ocr/5/tessdata --to /opt/tessdata
ENV PDF_PYTHON=/opt/pdf-venv/bin/python CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium PDF_LAYOUT_HOST=0.0.0.0 PDF_CHROMIUM_NO_SANDBOX=1 TESSDATA_PREFIX=/opt/tessdata
EXPOSE 8091
CMD ["node", "services/pdf-layout/server.mjs"]
