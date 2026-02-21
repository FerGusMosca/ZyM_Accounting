import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import websockets
from typing import AsyncGenerator

from common.util.std_in_out.root_locator import RootLocator


class DownloadNewsMCPClient:
    def __init__(self, symbol: str, portfolio: str = "SINGLE_STOCKS", uri: str = None):
        self._symbol = symbol
        self._portfolio = portfolio
        self._uri = uri  # fallback a settings
        self._report = "finviz_news_download"  # private fixed value
        self.last_output_file = None
        self.download_error =None
        self.last_error=None

    async def execute_and_stream(self) -> AsyncGenerator[str, None]:
        template_path = os.path.join(
            RootLocator.get_root(), "static", "mcp", "download_news.json"
        )
        with open(template_path, "r", encoding="utf-8") as f:
            payload = json.load(f)

        args = payload["params"]["arguments"]
        args["report"] = self._report
        args["portfolio"] = self._portfolio
        args["symbol"] = self._symbol

        self.download_error = False
        self.last_error = None

        try:
            async with websockets.connect(self._uri, ping_interval=None) as ws:
                # Optional debug
                await ws.send('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
                list_resp = await ws.recv()
                yield f"Tools list: {list_resp}\n\n"

                await ws.send(json.dumps(payload))

                while True:
                    message = await asyncio.wait_for(ws.recv(), timeout=120.0)
                    yield f"MSG >>> {message}\n\n"

                    try:
                        outer = json.loads(message)
                        if outer.get("method") == "job/progress":
                            inner_str = outer["params"].get("message", "")
                            if inner_str:
                                inner = json.loads(inner_str)
                                if inner.get("event") == "saved":
                                    saved_path = inner.get("path", "")
                                    if saved_path:
                                        folder = str(Path(saved_path).parent.parent)
                                        self.last_output_file = saved_path
                                        yield f"[EXTRACTED PATH] {folder}\n\n"
                        self.download_error=False
                    except json.JSONDecodeError as e:
                        yield f"[SKIP] Invalid JSON: {str(e)}\n\n"
                        self.download_error = True
                        self.last_error = str(e)

                    except Exception as e:
                        yield f"[PARSE ERROR] {str(e)}\n\n"
                        self.download_error = True
                        self.last_error = str(e)

        except Exception as e:
            yield f"Error: {str(e)}\n\n"
            self.download_error = True
            self.last_error = str(e)