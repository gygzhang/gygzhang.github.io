---
title: CUDA Reduce 优化笔记
date: 2023-04-24
tags: [CUDA, Performance]
visibility: public
---

### 问题介绍

reduce就是对一个数组的数据求sum, min, max, avg等操作，中文名叫规约，规约得到的结果数据维度应该是小于输入的的数据维度的。

reduce操作一般是一个memory-bound的kernel，算术强度(AI)很低，因此目标是提升peak bandwidth。 对于compute-bound的kernel，比如gemm，我们应该去实现peak GFLOPS/s.

### kernel 1 naive实现

第一个kernel如下：

![](/imgs/2023-04-24-21-10-39.png)

这个问题在于判断会导致warp divergent, 以及取模操作非常耗费cycle。
warp divergent指一个warp内的线程只有满足条件的线程会执行if内的语句，其他线程则处于idle状态，这些idle线程会占用宝贵的硬件资源，数据规模小的时候问题不大，因为硬件够用，但是一般用cuda都是大规模数据，因此必须消除这种divergent。

### kernel 2 避免warp divergent

第二个kernel如下：
![](/imgs/2023-04-24-21-16-12.png)

干活的线程个数其实没有变，只是将任务分配给具有连续全局id的线程，换句话说，将全局id连续的线程映射到需要处理的任务， 而之前是则不是这样，第一次循环，干活的线程id相差2， 第二次循环，干活的线程id相差4。 因为从0开始，每32个全局id连续的线程，它们是在同一个warp内的。因此， 除非需要处理的任务小于32个， 否则是不会发生warp divergent。 但是这样会带来新的问题, bank conflict.

### kernel 3 避免bank conflict

shared memory虽然很快，但是容易产生bank conflict。将shared memory可以想象成被组织成int smem[][32], smem数组的32列就是32个bank， 一个warp内的两个线程，如果访问一个bank内的不同地址，就会发生bank conflict。

对于kernel2， 第一轮迭代，`index=2*1*tid`, 对于一个warp中的32个线程，线程0，和线程16， 他们要访问的地址分别是0， 32， 对应到smen上，就是smem[0][0], smem[1][0], 他们位于同一个bank，因此会发生2-way bank conflict。第二轮迭代中， `index=2*2*tid`, warp中的32线程，线程0，8，16，32会访问一个bank的数据，因此发生了4-way的conflict。以此类推。

下面这样，即可避免bank conflict：
![](/imgs/2023-04-24-21-50-16.png)

这样之所以可以避免bank conflict， 是因为之前写smem不是连续的，同一个warp都乘了2的幂， 因此会发生bank conflict， 修改之后使用tid作为smem写入时的下标，对于一个warp，它们写入的是连续的地址，不会bank conflict。示意图如下所示：
![](/imgs/2023-04-24-21-57-40.png)

### kernel 4 make idle thread do more

加下来的问题是第一次迭代时，有一半的线程都处于空闲状态，这样是非常浪费的。

![](/imgs/2023-04-24-22-08-29.png)

这个优化，个人觉得是提高创建线程的性价比，修改之前，空闲的线程的唯一作用就是从global mem加载一个数据到smem。修改之后，每个线程加载两个数据，除此 之外，还做了一次加法。 要注意，因为每个线程现在处理两个数据，而BLOCKSIZE又没有变，因此，BLOCK个数要减半。

### kernel 循环展开

循环展开是一个很通用的优化手段，对于循环体内指令很少的kernel来说，循环控制部分的开销是不能忽略的，展开之后，可以有效的降低循环控制部分的占比。此外计算地址的开销也可以避免。 但是也不是展开了就一定好，展开过多可能会导致I-CACHE抖动（这个时候程序的瓶颈可能就在Instruction Fetch），或者寄存器不够，将数据写到local memory， local memory也是out of chip， 具有和globalmemory一样慢的速度。 具体如下：

![](/imgs/2023-04-24-22-27-46.png)

当s&lt;=32， 只有一个warp在干活，但是__syncthreads()会在所有block的所有warp之间同步，warp在一个simd单元上工作，本身就是同步，因此工作任务小于warpsize的时候，__syncthreads()完全没有必要。所以我们展开一个waro工作的情况。

关于volatile, 主要原因是因为smem也会被寄存器缓存，而寄存器又是线程私有的，如果B线程访问被A线程的寄存器缓存的位置，而A寄存器还没写会smem，这个时候结果肯定是不对的，volatile关键字告诉编译器从内存中读取，而不是寄存器。因此我猜测要么所有线程都不会将变量缓存到自己的寄存器，要么就访问的时候将寄存器中的值写会smem，但是这样感觉开销很大。 

看了Stack Overflow， 上面说

Removing the volatile keyword from that code could break that code on Fermi and Kepler GPUS. Those GPUs lack instructions to directly operate on shared memory. Instead, the compiler must emit a load/store pair to and from register.

What the volatile keyword does in this context is make the compiler honour that load-operate-store cycle and not perform an optimisation that would keep the value of s_data[tid] in register. To keep the sum accumulating in register would break the implicit memory syncronisation required to make that warp level shared memory summation work correctly.

所以sdata[tid]加了之后可能还存在于寄存器中，如果不写回smem， 其他线程要读取这个数据，就读取的没有更新的数据，这样算出来结果肯定是错的。

### kernel 6 完全展开

上面只展开了剩下任务个数等于warpsize的情况，还可以再展开，但是有一定如果BLOCKSIZE变了，我们需要注释一些或者或者添加一些代码，这样很麻烦，我们可以使用C++提供的模板功能，在编译期生成代码，自动实现展开。
![](/imgs/2023-04-24-22-59-32.png)

### kernel 7 一个线程计算更多元素

![](/imgs/2023-04-24-23-13-21.png)

## 参考

CSE 599 I Accelerated Computing - Programming GPUs Lecture 18.pdf
https://tschmidt23.github.io/cse599i/CSE%20599%20I%20Accelerated%20Computing%20-%20Programming%20GPUs%20Lecture%2018.pdf

https://www.eecs.umich.edu/courses/eecs570/hw/parprefix.pdf

https://developer.download.nvidia.com/assets/cuda/files/reduction.pdf

http://giantpandacv.com/project/OneFlow/%E3%80%90BBuf%E7%9A%84CUDA%E7%AC%94%E8%AE%B0%E3%80%91%E4%B8%89%EF%BC%8Creduce%E4%BC%98%E5%8C%96%E5%85%A5%E9%97%A8%E5%AD%A6%E4%B9%A0%E7%AC%94%E8%AE%B0/

https://stackoverflow.com/questions/21205471/cuda-in-warp-reduction-and-volatile-keyword?noredirect=1&lq=1
