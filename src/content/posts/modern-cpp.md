---
title: 现代 C++ 基础
date: 2022-07-27
tags: [C++]
visibility: public
---

### 关于完美转发

C++完美转发实现原理：万能引用、引用折叠

### std::mem_fn

如果你用&Item::Foo调用for_each()，代码会尝试调用(&Item::Foo)(x)，这是病态的，因为指向成员的指针必须写(x.*&Item::Foo)()。mem_fn要解决的正是语法上的差异:mem_fn处理成员指针的调用语法，这样就可以使用成员指针以及函数和函数对象的所有算法。

```cpp
template
UnaryFunction for_each(InputIt first, InputIt last, UnaryFunction f)
{
    for (; first != last; ++first) {
        f(*first); // return f;
}

```

c++ - Why use mem_fn? - Stack Overflow
