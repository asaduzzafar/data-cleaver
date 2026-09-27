"""Bounded query concurrency that can say where you are in the line.

A plain semaphore would cap concurrency perfectly well, but it cannot answer
"how many are ahead of me?" -- and a waiting query looks exactly like a hung
one. People respond to that by clicking Run again, which lengthens the very
queue that was the problem. So the waiters are tracked in arrival order and
each one can be asked for its position.

asyncio.Semaphore wakes waiters FIFO, so index order here matches grant order.
"""

import asyncio
from contextlib import asynccontextmanager


class SlotQueue:
    def __init__(self, size):
        self.size = size
        self._sem = asyncio.Semaphore(size)
        self._waiting = []  # tickets, oldest first
        self._active = 0

    @asynccontextmanager
    async def hold(self, ticket):
        """Occupy a slot for the duration of the block.

        `ticket` is any hashable identity -- a job id in practice. It is
        removed from the queue whether the wait succeeds or is cancelled, so a
        caller that gives up never leaves a phantom ahead of everyone else.
        """
        self._waiting.append(ticket)
        try:
            await self._sem.acquire()
        finally:
            try:
                self._waiting.remove(ticket)
            except ValueError:
                pass
        self._active += 1
        try:
            yield
        finally:
            self._active -= 1
            self._sem.release()

    def position(self, ticket):
        """1 = next to run. 0 = not waiting (running, finished, or unknown)."""
        try:
            return self._waiting.index(ticket) + 1
        except ValueError:
            return 0

    def snapshot(self):
        return {
            "slots": self.size,
            "running": self._active,
            "waiting": len(self._waiting),
            "free": max(0, self.size - self._active),
        }
