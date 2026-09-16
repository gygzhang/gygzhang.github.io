---
title: CUDA Prefix Scan 优化笔记
date: 2023-04-25
tags: [CUDA, Algorithms]
visibility: public
---

## 什么是prefix scan

前缀和是一个很常见的操作，刷LC的时候，也有很多题需要用到前缀和，以达到减少计算量的效果，最近一次用到前缀和是在写SPGEMM的时候，在symbolic阶段，我们计算出了一个长度为m的向量nnz，nnz[i]表示结果C中第i行有多少个非零的结果，需要计算的矩阵C需要按CSR格式储存，其中col和val数组被分成多个段，每一个段代表对应稠密的一行，而段的起始和结束位置由row数组来指示，具体来说，row[i]表示起始位置，row[i+1]代表结束位置， 也就是`val[row[i]]` 至val`[row[i+1]]`是第i行的数据(注意不包括`[row[i+1]]`， 是一个左闭右开的区间)。 因此求前缀和就理所当然了，而且是exclusive scan, 因为第i个位置的结果`f[i]`不包含第i个输入。 `f[i]`可以理解为前i-1行有多少个非0元素。

## double buffered version

首先是双缓冲版本：
![](/imgs/2023-04-25-20-31-00.png)

示意图如下：
![](/imgs/2023-04-25-20-31-26.png)

这是一个nlogn的算法，
证明如下：
![](/imgs/2023-04-25-22-08-29.png)

第i次迭代，有2*(i-1)个结果被计算出来，所以下一次参与计算线程个数会减少2^(i-1)，因此第i次迭代，所有线程操作次数是2^M-2^(i-1)， i取值从0到M-1。

代码如下：

```cpp
__global__ void scan(float *g_odata, float *g_idata, int n) 
{ 
    extern  __shared__  float temp[]; // allocated on invocation 
    int thid = threadIdx.x; 
    int pout = 0, pin = 1; 
    // load input into shared memory.  
    // This is exclusive scan, so shift right by one and set first elt to 0 
    temp[pout*n + thid] = (thid > 0) ? g_idata[thid-1] : 0; 
    __syncthreads(); 
    for (int offset = 1; offset 2) 
    { 
        pout = 1 - pout; // swap double buffer indices 
        // 这里应该写错了， pin = 1-pin才对
        pin  = 1 - pout; 
        if (thid >= offset) 
            temp[pout*n+thid] += temp[pin*n+thid - offset]; 
        else 
            temp[pout*n+thid] = temp[pin*n+thid]; 
        __syncthreads(); 
    } 
    g_odata[thid] = temp[pout*n+thid1]; // write output 
} 

```

上面这段算法问题在于复杂度不如串行低，而且只能处理一个block可以处理的数据，如果一个block最多可以有512个线程，那么数组长度最多为1024. 因此大佬提出了基于平衡树的算法。

## work efficient 算法

### 介绍

这个算法使用了平衡树，但是并不是在GPU上使用平衡树这种数据结构，而是用来决定每次迭代，每个线程应该做什么。说起来很抽象，看图应该很清晰。算法分为两个阶段。

- 第一个阶段自底向上从叶子到根遍历，作用是构建部分和，每一个root的值都是其所有叶子节点之和。

- 第二个阶段自顶向下从root到leaves遍历，根据partial sum来构建scan。

### 算法过程

第一个阶段如下：
![](/imgs/2023-04-25-22-31-03.png)

第二个阶段：
![](/imgs/2023-04-25-22-32-04.png)

代码如下：
![](/imgs/2023-04-25-22-32-57.png)

看这个代码的时候，觉得确实应该是这样，很巧妙，但是自己想肯定大概率是想不出来的。 分析一下代码，首先是每个线程加载2个元素到smem中，0号线程加载内存位置为0,1， 1号线程加载2，3，… 这样的模式，可以预见，应该是会产生bank conflict的，因为第16个线程会加载内存位置为32，33的元素，和0号线程加载的内存位置在同一个bank。 接下来，进入循环，

```cpp
这里有一个假设，如果block中线程个数为512， n一定是1024, 第一轮肯定是相邻的元素相加，这会得到512个结果，所以需要用512个线程。
for (int d = n>>1; d > 0; d >>= 1) // build sum in place up the tree 
{ 
    __syncthreads(); 
    if (thid // bi是线程要写入的数组下标， 可以观察到如果将线程id+1，那么
        // 第一轮迭代写入的下标就是2*(thid+1)， 第二轮迭代写入的下标bi会
        // 加倍，offset的作用就是这个，它每轮迭代会加倍，因此bi=offset*2*(thid+1)
        // 但是要注意， 下标是从0开始的，所以所有下标都要减1，而ai可以看出，和bi相差offset。因此ai=bi-offset
        int ai = offset*(2*thid+1)-1; 
        int bi = offset*(2*thid+2)-1; 
        temp[bi] += temp[ai];         
    } 
    offset *= 2; 
}

```

接下来要清除temp的最后一个位置的元素。然后进行从root到leaves的遍历。

```cpp
for (int d = 1; d 2) // traverse down tree & build scan 
{ 
    offset >>= 1; 
    __syncthreads(); 
    if (thid int ai = offset*(2*thid+1)-1; 
        // int bi = offset*2*(thid+1)-1
        int bi = offset*(2*thid+2)-1; 
        // 因为没有用double buffer， 所以要先保存ai位置的值，然后再写这个位置
        float t   = temp[ai]; 
        // 把root的值传到左孩子。
        temp[ai]  = temp[bi]; 
        // 把root和左孩子的和写到右孩子
        temp[bi] += t; 
    } 
}

```

### 解决bank conflict

这个代码有个问题需要解决，那就是bank conflict， 解决方案就是使用padding

![](/imgs/2023-04-26-00-17-27.png)

我们定义这样的宏：

```cpp
#define SHARED_MEMORY_BANKS 32
#define LOG_MEM_BANKS 5
#define ROW_BY_32(n) ((n) >> LOG_MEM_BANKS)

```

我们将smem抽象成int smem[][32], ROW_BY_32计算传入的地址属于smem的第几行。第几行。如果我们加了padding，那么smem的定义就会变成int smem[][33], 原本要访问的地址是n：

- 如果属于第0行，那么加padding之后的地址应该变成n+0,

- 如果属于第1行，那么加padding之后的地址应该变成n+1,

- 如果属于第2行，那么加padding之后的地址应该变成n+2,

- 以此类推…

可以看出，如果数据有n行，就需要浪费n*4 byte的空间，虽然浪费了空间，但是避免了bank conflict，是一种以时间换空间的思想。一个block的线程是512的话，512/32=16，所以padding会占用64 byte的空间。

一开始我们从全局内存加载数据到smem中的时候，每个线程加载两个相邻的数据，可以知道，第16个线程会加载第32，33个数据，第32个线程会加载第64,65个数据，因此发生了3-way bank conflict， 因此我们改变策略，我们知道，一个block的数据个数是线程个数的2倍，因此将数据分为两半，block的第i个线程加载第`g_data[0]`和`g_data[0+n/2]`， 这样可以保证一个warp访问的数据是连续的，因此不会发生bank conflict。代码如下

```cpp
int ai = threadID;
int bi = threadID + (n / 2);
int bankOffsetA = CONFLICT_FREE_OFFSET(ai);
int bankOffsetB = CONFLICT_FREE_OFFSET(bi);
temp[ai + bankOffsetA] = input[ai];
temp[bi + bankOffsetB] = input[bi];

```

root和leaves之间的代码：

```cpp
int ai = offset*(2*thid+1)-1; 
int bi = offset*(2*thid+2)-1; 
ai += CONFLICT_FREE_OFFSET(ai); 
bi += CONFLICT_FREE_OFFSET(bi);

```

假设offset=1, 那么ai=2*thid, 0~32线程访问的bi为1，3，5，…31,33,
三个线程会访问bank0：

- thid=0,  ai=0

- thid=16, ai=32

- thid=32, ai=64

加了padding之后， ai = ai + ai/32

- thid=0,  ai=0  + 0 = 0

- thid=16, ai=32 + 1 = 33

- thid=32, ai=64 + 2 = 66

可以看出，他们的bank分别变成了0,1,2，从而避免了bank conflict， bi同理。

### 任意大小的数据

上面的代码问题在于只能处理blockDim.x*2个数据，因此需要考虑更多数据如何设计算法，其实也很简单，因为可以将大的数组分为多个block，每个block单独处理，最后再设计一个kernel更新最终的答案。

流程如下：
![](/imgs/2023-04-26-01-01-08.png)

## 参考

http://users.umiacs.umd.edu/~ramani/cmsc828e_gpusci/ScanTalk.pdf
