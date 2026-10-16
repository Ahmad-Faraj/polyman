// Mutant (WA): off-by-one, the last element never reaches the sum.
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
        if (i < n - 1)
            sum += x;
    }
    std::cout << (sum % 2 == 0 ? "YES" : "NO") << "\n";
    return 0;
}
