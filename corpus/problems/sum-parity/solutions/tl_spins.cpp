// Mutant (TL): never terminates, so it exceeds any time limit by a wide margin.
#include <bits/stdc++.h>

int main()
{
    volatile unsigned long long spin = 0;
    while (true)
        spin++;
}
