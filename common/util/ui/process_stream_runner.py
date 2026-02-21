import subprocess
import asyncio


class ProcessStreamRunner:

    @staticmethod
    async def stream_process(cmd, logger, tag, on_line=None):
        logger.info(f"[{tag}] CMD: {cmd}")

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )

        try:
            while True:

                line = await asyncio.to_thread(process.stdout.readline)

                if not line:
                    break

                logger.info(f"[{tag}] {line.strip()}")
                if on_line:
                    on_line(line)
                yield line

        except Exception as ex:
            logger.exception(f"[{tag}] Runtime error")
            yield f"\n❌ Runtime error: {ex}\n"

        finally:
            try:
                process.stdout.close()
                process.wait()
                logger.info(f"[{tag}] Finished")
            except Exception:
                pass
