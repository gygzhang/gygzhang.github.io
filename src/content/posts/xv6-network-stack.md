---
title: xv6 网络协议栈实现分析
date: 2022-03-19
tags: [xv6, OS]
visibility: public
---

最近做了xv6的实验:
Lab: networking

实验要求还是很简单，对比了一下之前的实验，发现难度降低不是一点半点，所以就阅读了xv6内部的socket协议栈的实现。

xv6和linux一样，都是一切皆文件，所以如果用户想要向socket读写数据，也是要调用read/write，而r/w在内核里面调用的是fileread和filewrite.

以下是read的实现：

1
2
3
4
5
6
7
8
9
10
11
uint64
sys_read(void)
&#123;
  struct file *f;
  int n;
  uint64 p;

  if(argfd(0, 0, &f) &lt; 0 || argint(2, &n) &lt; 0 || argaddr(1, &p) &lt; 0)
    return -1;
  return fileread(f, p, n);
&#125;

write类似.

file结构体的定义如下：

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
struct file &#123;
#ifdef LAB_NET
  enum &#123; FD_NONE, FD_PIPE, FD_INODE, FD_DEVICE, FD_SOCK &#125; type;
#else
  enum &#123; FD_NONE, FD_PIPE, FD_INODE, FD_DEVICE &#125; type;
#endif
  int ref; // reference count
  char readable;
  char writable;
  struct pipe *pipe; // FD_PIPE
  struct inode *ip;  // FD_INODE and FD_DEVICE
#ifdef LAB_NET
  struct sock *sock; // FD_SOCK
#endif
  uint off;          // FD_INODE
  short major;       // FD_DEVICE
&#125;;

可以看到，file结构体内部有一个枚举变量type，当fileread检测到fd-&gt;type为FD_SOCK，即socket文件时，便会调用sockread来读取socket文件。

sockread首先会获取文件的锁，然后检测该socket文件对应的接收队列是否为空，如果为空，说明网卡还没有接收到数据，则进程应该进入睡眠状态，等待唤醒。  如果该socket的接收队列不为空，则从接收队列中pop一个消息，该消息对应的结构体为mbuf。定义如下：

1
2
3
4
5
6
struct mbuf &#123;
  struct mbuf  *next; // the next mbuf in the chain
  char         *head; // the current start position of the buffer
  unsigned int len;   // the length of the buffer
  char         buf[MBUF_SIZE]; // the backing store
&#125;;

获取消息后，就使用copyout函数将，消息从内核空间中复制到用户空间中。

刚刚提到如果指定socket对应的接收队列为空，那么它怎么被唤醒的呢？

为了搞清楚这个问题，我们首先来看网卡驱动程序，网络属于外部设备，所以如果有数据到来，网卡设备会以中断的方式通知CPU，cpu则会调用中断处理函数，网卡的中断处理函数为e1000_intr(),定义如下：

1
2
3
4
5
6
7
8
9
10
void
e1000_intr(void)
&#123;
  // tell the e1000 we&#x27;ve seen this interrupt;
  // without this the e1000 won&#x27;t raise any
  // further interrupts.
  regs[E1000_ICR] = 0xffffffff;

  e1000_recv();
&#125;

可以看到，中断函数将调用e1000_recv来接收到来的数据，这也是xv6实验要求我们实现的函数之一，通过查询手册，该函数实现如下：

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
static void
e1000_recv(void)
&#123;
  //
  // Your code here.
  //
  // Check for packets that have arrived from the e1000
  // Create and deliver an mbuf for each packet (using net_rx()).
  //
  //should recive all packets
  while(1)&#123;
    acquire(&e1000_lock);
    int index = (regs[E1000_RDT]+1)%RX_RING_SIZE;
    if((rx_ring[index].status&E1000_RXD_STAT_DD)==0)&#123;
      release(&e1000_lock);
      return;
    &#125;
    rx_mbufs[index]-&gt;len = rx_ring[index].length;
    release(&e1000_lock);
    net_rx(rx_mbufs[index]);
    acquire(&e1000_lock);
    regs[E1000_RDT] = index;
    rx_mbufs[index] = mbufalloc(0);
    rx_ring[index].addr = (uint64)rx_mbufs[index]-&gt;head;
    rx_ring[index].status = 0;
    index = (regs[E1000_RDT]+1)%RX_RING_SIZE;
    release(&e1000_lock);
    
  &#125;
  return;
&#125;

该函数用到了两个关键的数据结构。一个是rx_ring(接收环)的数组，其元素是rx_desc(接收描述符)，这两个数据结构都是和e1000网卡密切相关的，rx_ring就是一个循环数组，rx_desc内部有很多field，e1000网卡接收到数据之后，数据便是储存在rx_desc之中的。

要读取数据，需要用到E1000_RDT这个寄存器，手册里面说的：
HARDWARE OWNS ALL DESCRIPTORS BETWEEN [HEAD AND TAIL].
结合HEAD和TAIL寄存器的说明，我们应该将HEAD初始化为0，TAIL初始化为环形数组的最后一个位置，这样硬件能将到来的网络包储存在HEAD和TAIL之间，如果收到一个packet，硬件就会将它放到HEAD指向的位置，由此应该用(regs[E1000_RDT]+1)%RX_RING_SIZE来读取接收到的数据包。

重点是，网卡一次可能接收到了很多包，所以e1000_recv函数应该遍历在TAIL-&gt;HEAD之间所有的描述符，直到遇到一个描述符的状态域的E1000_RXD_STAT_DD为0，则表示所以数据都被读取完毕，应该返回。

读取到的数据会传递给net_rx()函数，这个函数会将这个以太网数据包的头部提取出来，然后判断上层协议类型是什么(xv6协议栈支持IP,ARP)，代码如下：

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
void net_rx(struct mbuf *m)
&#123;
  struct eth *ethhdr;
  uint16 type;

  ethhdr = mbufpullhdr(m, *ethhdr);
  if (!ethhdr) &#123;
    mbuffree(m);
    return;
  &#125;

  type = ntohs(ethhdr-&gt;type);
  if (type == ETHTYPE_IP)
    net_rx_ip(m);
  else if (type == ETHTYPE_ARP)
    net_rx_arp(m);
  else
    mbuffree(m);
&#125;

我们假设这个以太网的上层协议是ip，那么接下来，应该判断ip数据报的上层协议了，xv6的实现只支持udp。因此，在net_rx_ip函数内部会调用net_rx_udp函数.

这个函数会解析udp数据包的头部，然后转到sockrecvudp()函数，该函数的定义如下：

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
// called by protocol handler layer to deliver UDP packets
void
sockrecvudp(struct mbuf *m, uint32 raddr, uint16 lport, uint16 rport)
&#123;
  //
  // Find the socket that handles this mbuf and deliver it, waking
  // any sleeping reader. Free the mbuf if there are no sockets
  // registered to handle it.
  //
  struct sock *si;

  acquire(&lock);
  si = sockets;
  while (si) &#123;
    if (si-&gt;raddr == raddr && si-&gt;lport == lport && si-&gt;rport == rport)
      goto found;
    si = si-&gt;next;
  &#125;
  release(&lock);
  mbuffree(m);
  return;

found:
  acquire(&si-&gt;lock);
  mbufq_pushtail(&si-&gt;rxq, m);
  wakeup(&si-&gt;rxq);
  release(&si-&gt;lock);
  release(&lock);
&#125;

这个函数用了到sockets，这是一个链表，内核中所有的socket都被链接到这个sockets链表上。这个函数遍历这个链表，如果发现有socket的地址和端口号符合刚刚在net_rx_udp()中解析得到的地址和端口号，则会将消息推进该socket对应的接收缓冲区之中，然后唤醒之前因为没有缓冲区为空而睡眠的进程。
