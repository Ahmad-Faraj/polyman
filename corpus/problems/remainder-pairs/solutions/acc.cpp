// Main solution: one pass; each value pairs with every earlier value whose
// remainder completes its own to a multiple of k.
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
    long long pairs = 0;
    for (int i = 0; i < n; i++)
    {
        long long a;
        cin >> a;
        long long r = a % k;
        auto it = count.find((k - r) % k);
        if (it != count.end())
            pairs += it->second;
        count[r]++;
    }
    cout << pairs << '\n';
    return 0;
}
