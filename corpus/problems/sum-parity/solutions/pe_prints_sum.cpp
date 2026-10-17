// Mutant (PE): prints the sum instead of YES/NO, which the checker reports as a presentation error.
#include <bits/stdc++.h>

int main()
{
    int n;
    std::cin >> n;
    long long sum = 0;
    for (int i = 0; i < n; i++)
    {
        int x;
        std::cin >> x;
        sum += x;
    }
    std::cout << sum << "\n";
    return 0;
}
