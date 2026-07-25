# common/llm_client/llm_factory.py
"""
LLM Factory — instantiates any BaseLLM from a dotted class path string.

.env pattern (same convention as INTENT_DETECTION_LOGIC):
  LLM_CLASS=common.llm_client.openai_llm.OpenAILLM

The factory never imports concrete implementations at module level.
All resolution is done at call time via importlib.
All comments in English.
"""
from __future__ import annotations
import importlib
from typing import Optional, Any

from common.llm_client.base_llm import BaseLLM

# Built-in shorthand aliases → full dotted paths
# Allows using LLM_CLASS=openai in .env instead of the full path
_ALIASES: dict[str, str] = {
    "openai": "common.llm_client.openai_llm.OpenAILLM",
}

_DEFAULT_CLASS = "common.llm_client.openai_llm.OpenAILLM"


class LLMFactory:
    """
    Resolves and instantiates a BaseLLM from a dotted class path string.

    Usage:
        # From settings (recommended)
        llm = LLMFactory.from_class_path(
            class_path  = settings.llm_class,   # "common.llm_client.openai_llm.OpenAILLM"
            model_name  = settings.llm_model,
            temperature = settings.llm_temperature,
        )

        # Shorthand alias
        llm = LLMFactory.from_class_path("openai", model_name="gpt-4o-mini")
    """

    @staticmethod
    def from_class_path(
        class_path:  Optional[str] = None,
        model_name:  str           = "gpt-4o-mini",
        temperature: float         = 0.0,
        max_tokens:  Optional[int] = None,
        **extra_kwargs: Any,
    ) -> BaseLLM:
        """
        Resolves class_path → imports class → instantiates with given params.
        Accepts:
          - Full dotted path: "common.llm_client.openai_llm.OpenAILLM"
          - Alias:            "openai"
          - None:             falls back to OpenAILLM
        """
        resolved = _ALIASES.get(class_path or "", class_path or _DEFAULT_CLASS)
        cls      = LLMFactory._import_class(resolved)

        return cls(
            model_name  = model_name,
            temperature = temperature,
            max_tokens  = max_tokens,
            **extra_kwargs,
        )

    # kept for backwards compat with existing callers that use .create()
    @staticmethod
    def create(
        class_path:  Optional[str] = None,
        model_name:  str           = "gpt-4o-mini",
        temperature: float         = 0.0,
        max_tokens:  Optional[int] = None,
        **extra_kwargs: Any,
    ) -> BaseLLM:
        return LLMFactory.from_class_path(
            class_path  = class_path,
            model_name  = model_name,
            temperature = temperature,
            max_tokens  = max_tokens,
            **extra_kwargs,
        )

    @staticmethod
    def _import_class(dotted_path: str) -> type:
        """
        Dynamically imports a class from a dotted module path.
        "common.llm_client.openai_llm.OpenAILLM"
          → module: "common.llm_client.openai_llm"
          → class:  "OpenAILLM"
        """
        if "." not in dotted_path:
            raise ValueError(
                f"[LLMFactory] Invalid path '{dotted_path}'. "
                "Expected: 'module.path.ClassName'"
            )

        module_path, class_name = dotted_path.rsplit(".", 1)

        try:
            module = importlib.import_module(module_path)
        except ModuleNotFoundError as e:
            raise ImportError(
                f"[LLMFactory] Cannot import '{module_path}': {e}"
            ) from e

        cls = getattr(module, class_name, None)
        if cls is None:
            raise AttributeError(
                f"[LLMFactory] Class '{class_name}' not found in '{module_path}'"
            )

        return cls