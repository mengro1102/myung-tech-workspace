#!/usr/bin/env python3
"""
장기기억 FT (Phase 5) — GraphRAG 지식 → SFT 데이터셋 → LoRA 파인튜닝.

설계: 학습 자체는 무겁고 GPU가 필요하므로 이 모듈은
  (1) GraphRAG 노드 → SFT 학습쌍(JSONL) 생성, (2) 바로 실행 가능한
  Google Colab 노트북(.ipynb) 생성 까지만 담당한다. 실제 학습은
  Colab(무료 T4) 또는 로컬 GPU(RTX 3090)에서 수행한다.
외부 의존성 없음(표준 라이브러리).
"""
from __future__ import annotations

import json
from pathlib import Path

import knowledge_base as kb


def build_sft_dataset(out_path: Path, *, mode: str = "sft") -> dict:
    """GraphRAG 노드 → instruction/output JSONL. (count, path) 반환.

    각 노드(개념·엔티티·비교)를 '제목 설명' 형태의 지도학습 쌍으로 변환.
    DPO는 선호쌍(chosen/rejected)이 필요해 별도 데이터 수집이 필요 — 현재는 SFT.
    """
    if not kb.available():
        raise FileNotFoundError("GraphRAG 지식베이스를 찾을 수 없음 (GRAPHRAG_KB_PATH)")
    rows = []
    for slug in kb.list_nodes():
        try:
            text = kb.read_node(slug)
        except OSError:
            continue
        body = _strip_frontmatter(text).strip()
        if len(body) < 40:
            continue
        title = slug.split("/", 1)[-1].replace("-", " ")
        rows.append({
            "instruction": f"{title}에 대해 설명해줘.",
            "input": "",
            "output": body[:4000],
        })
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return {"count": len(rows), "path": str(out_path), "mode": mode}


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:]
    return text


def make_colab_notebook(out_path: Path, *, base_model: str, hf_repo: str,
                        rank: int = 16, epochs: int = 3, lr: float = 2e-4,
                        dataset_file: str = "sft_dataset.jsonl") -> dict:
    """LoRA SFT용 Colab 노트북(.ipynb) 생성. 무료 T4 기준 unsloth 사용."""
    md = lambda *xs: {"cell_type": "markdown", "metadata": {}, "source": list(xs)}
    code = lambda *xs: {"cell_type": "code", "metadata": {}, "execution_count": None,
                        "outputs": [], "source": list(xs)}
    cells = [
        md(f"# 명테크 장기기억 LoRA 파인튜닝\n",
           f"- base: `{base_model}`\n- push: `{hf_repo}`\n",
           f"- LoRA rank {rank} · epochs {epochs} · lr {lr}\n",
           "런타임 → GPU(T4) 선택 후 위에서부터 실행하세요."),
        code("!pip -q install \"unsloth[colab-new]\" trl peft datasets transformers"),
        md("## 1) 데이터셋 업로드\n좌측 파일에 `" + dataset_file + "` 업로드하거나 아래로 업로드"),
        code("from google.colab import files\n",
             "up = files.upload()  # " + dataset_file + " 선택"),
        code("from datasets import load_dataset\n",
             f"ds = load_dataset('json', data_files='{dataset_file}', split='train')\n",
             "def fmt(e):\n",
             "    return {'text': f\"### 지시:\\n{e['instruction']}\\n\\n### 응답:\\n{e['output']}\"}\n",
             "ds = ds.map(fmt)\n",
             "print(len(ds), ds[0]['text'][:200])"),
        md("## 2) 모델 로드 (LoRA)"),
        code("from unsloth import FastLanguageModel\n",
             f"model, tok = FastLanguageModel.from_pretrained('{base_model}', max_seq_length=1024, load_in_4bit=True)\n",
             f"model = FastLanguageModel.get_peft_model(model, r={rank}, lora_alpha={rank*2},\n",
             "    target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj'])"),
        md("## 3) 학습"),
        code("from trl import SFTTrainer\n",
             "from transformers import TrainingArguments\n",
             "tok.pad_token = tok.pad_token or tok.eos_token\n",
             "trainer = SFTTrainer(model=model, tokenizer=tok, train_dataset=ds,\n",
             "    dataset_text_field='text', max_seq_length=1024,\n",
             f"    args=TrainingArguments(per_device_train_batch_size=2, gradient_accumulation_steps=4,\n",
             f"        num_train_epochs={epochs}, learning_rate={lr}, fp16=True, logging_steps=10,\n",
             "        output_dir='out', optim='adamw_8bit'))\n",
             "trainer.train()"),
        md("## 4) 허깅페이스 업로드"),
        code("from huggingface_hub import login\n",
             "login()  # HF 토큰 입력\n",
             f"model.push_to_hub('{hf_repo}'); tok.push_to_hub('{hf_repo}')\n",
             f"print('완료 → https://huggingface.co/{hf_repo}')"),
    ]
    nb = {"cells": cells, "metadata": {"accelerator": "GPU",
          "colab": {"provenance": []}, "kernelspec": {"name": "python3", "display_name": "Python 3"}},
          "nbformat": 4, "nbformat_minor": 0}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"path": str(out_path), "base_model": base_model, "hf_repo": hf_repo}
