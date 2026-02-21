FROM python:3.10-slim

WORKDIR /app

# System dependencies + wkhtmltopdf para generación de PDFs
RUN apt-get update && apt-get install -y \
    wkhtmltopdf \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app
COPY . /app

EXPOSE 9004

CMD ["python", "main.py"]