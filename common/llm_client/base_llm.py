# common/llm_client/base_llm.py
"""
Abstract base class for all LLM providers.
All callers depend ONLY on this interface — never on concrete implementations.
All comments in English.
"""
from abc import ABC, abstractmethod
from typing import Iterator


class BaseLLM(ABC):

    @abstractmethod
    def invoke(self, prompt: str) -> str:
        """Single-turn: prompt → full response string."""
        ...

    @abstractmethod
    def stream(self, prompt: str) -> Iterator[str]:
        """Single-turn streaming: prompt → token chunks."""
        ...

    @abstractmethod
    def handle(self, query: str) -> str:
        """Alias for invoke — pipeline compatibility."""
        ...