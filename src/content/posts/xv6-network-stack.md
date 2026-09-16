---
title: xv6 网络协议栈实现分析
date: 2022-03-19
tags: [xv6, OS]
visibility: public
---

最近做了xv6的实验:
Lab: networking

实验要求还是很简单，对比了一下之前的实验，发现难度降低不是一点半点，所以就阅读了xv6内部的socket协议栈的实现。

xv6和linux一样，都是一切皆文件，所以如果用户想要向`socket`读写数据，也是要调用`read/write`，而r/w在内核里面调用的是`fileread`和`filewrite`.

以下是`read`的实现：

```cpp
uint64
sys_read(void)
{
  struct file *f;
  int n;
  uint64 p;

  if(argfd(0, 0, &f) len = rx_ring[index].length;
    release(&e1000_lock);
    net_rx(rx_mbufs[index]);
    acquire(&e1000_lock);
    regs[E1000_RDT] = index;
    rx_mbufs[index] = mbufalloc(0);
    rx_ring[index].addr = (uint64)rx_mbufs[index]->head;
    rx_ring[index].status = 0;
    index = (regs[E1000_RDT]+1)%RX_RING_SIZE;
    release(&e1000_lock);
    
  }
  return;
}

```

该函数用到了两个关键的数据结构。一个是rx_ring(接收环)的数组，其元素是rx_desc(接收描述符)，这两个数据结构都是和e1000网卡密切相关的，rx_ring就是一个循环数组，rx_desc内部有很多field，e1000网卡接收到数据之后，数据便是储存在rx_desc之中的。

要读取数据，需要用到E1000_RDT这个寄存器，手册里面说的：
HARDWARE OWNS ALL DESCRIPTORS BETWEEN [HEAD AND TAIL].
结合HEAD和TAIL寄存器的说明，我们应该将HEAD初始化为0，TAIL初始化为环形数组的最后一个位置，这样硬件能将到来的网络包储存在HEAD和TAIL之间，如果收到一个packet，硬件就会将它放到HEAD指向的位置，由此应该用`(regs[E1000_RDT]+1)%RX_RING_SIZE`来读取接收到的数据包。

重点是，网卡一次可能接收到了很多包，所以e1000_recv函数应该遍历在TAIL-&gt;HEAD之间所有的描述符，直到遇到一个描述符的状态域的E1000_RXD_STAT_DD为0，则表示所以数据都被读取完毕，应该返回。

读取到的数据会传递给net_rx()函数，这个函数会将这个以太网数据包的头部提取出来，然后判断上层协议类型是什么(xv6协议栈支持IP,ARP)，代码如下：

```cpp
void net_rx(struct mbuf *m)
{
  struct eth *ethhdr;
  uint16 type;

  ethhdr = mbufpullhdr(m, *ethhdr);
  if (!ethhdr) {
    mbuffree(m);
    return;
  }

  type = ntohs(ethhdr->type);
  if (type == ETHTYPE_IP)
    net_rx_ip(m);
  else if (type == ETHTYPE_ARP)
    net_rx_arp(m);
  else
    mbuffree(m);
}

```

我们假设这个以太网的上层协议是ip，那么接下来，应该判断ip数据报的上层协议了，xv6的实现只支持udp。因此，在`net_rx_ip`函数内部会调用`net_rx_udp`函数.

这个函数会解析udp数据包的头部，然后转到sockrecvudp()函数，该函数的定义如下：

```cpp
// called by protocol handler layer to deliver UDP packets
void
sockrecvudp(struct mbuf *m, uint32 raddr, uint16 lport, uint16 rport)
{
  //
  // Find the socket that handles this mbuf and deliver it, waking
  // any sleeping reader. Free the mbuf if there are no sockets
  // registered to handle it.
  //
  struct sock *si;

  acquire(&lock);
  si = sockets;
  while (si) {
    if (si->raddr == raddr && si->lport == lport && si->rport == rport)
      goto found;
    si = si->next;
  }
  release(&lock);
  mbuffree(m);
  return;

found:
  acquire(&si->lock);
  mbufq_pushtail(&si->rxq, m);
  wakeup(&si->rxq);
  release(&si->lock);
  release(&lock);
}

```

这个函数用了到`sockets`，这是一个链表，内核中所有的`socket`都被链接到这个`sockets`链表上。这个函数遍历这个链表，如果发现有`socket`的地址和端口号符合刚刚在`net_rx_udp()`中解析得到的地址和端口号，则会将消息推进该`socket`对应的接收缓冲区之中，然后唤醒之前因为没有缓冲区为空而睡眠的进程。
