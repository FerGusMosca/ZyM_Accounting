FROM python:3.10-slim

WORKDIR /app

# System dependencies + wkhtmltopdf desde paquete oficial para Debian Bookworm
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    fontconfig \
    libfreetype6 \
    libjpeg62-turbo \
    libpng16-16 \
    libx11-6 \
    libxcb1 \
    libxext6 \
    libxrender1 \
    xfonts-75dpi \
    xfonts-base \
    && curl -L https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-3/wkhtmltox_0.12.6.1-3.bookworm_amd64.deb \
       -o /tmp/wkhtmltox.deb \
    && dpkg -i /tmp/wkhtmltox.deb || apt-get install -fy \
    && rm /tmp/wkhtmltox.deb \
    && rm -rf /var/lib/apt/lists/* \
    && wkhtmltopdf --version

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app
COPY . /app

EXPOSE 9004

CMD ["python", "main.py"]