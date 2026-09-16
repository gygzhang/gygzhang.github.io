---
title: CUDA SGEMM 优化笔记
date: 2023-04-27
tags: [CUDA, Performance]
visibility: public
---

blockDim.x

ptxas info    : Used 63 registers, 8192 bytes smem, 368 bytes cmem[0]
ptxas info    : Compiling entry function ‘_Z18sgemm2DBlocktilingILi64ELi64ELi8ELi8ELi8EEviiifPKfS1_fPf’ for ‘sm_30’
ptxas info    : Function properties for _Z18sgemm2DBlocktilingILi64ELi64ELi8ELi8ELi8EEviiifPKfS1_fPf
    104 bytes stack frame, 260 bytes spill stores, 184 bytes spill loads

```cpp
ptxas info    : Used 63 registers, 8192 bytes smem, 368 bytes cmem[0]

```

ptxas info    : Compiling entry function ‘_Z18sgemm2DBlocktilingILi64ELi64ELi8ELi8ELi8EEviiifPKfS1_fPf’ for ‘sm_30’
ptxas info    : Function properties for _Z18sgemm2DBlocktilingILi64ELi64ELi8ELi8ELi8EEviiifPKfS1_fPf
    600 bytes stack frame, 1636 bytes spill stores, 1440 bytes spill loads
