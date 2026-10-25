// Mutant (WA): counts pairs class by class, remainder r with k - r and the
// multiples of k among themselves, but forgets that for even k the remainder
// k/2 pairs with itself.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    long long k;
    cin >> n >> k;
    map<long long, long long> count;
    for (int i = 0; i < n; i++)
    {
        long long a;
        cin >> a;
        count[a % k]++;
    }

    long long pairs = 0;
    for (auto [r, c] : count)
    {
        if (r == 0)
            pairs += c * (c - 1) / 2;
        else if (r < k - r && count.count(k - r))
            pairs += c * count[k - r];
    }
    cout << pairs << '\n';
    return 0;
}
