// Correct, and usually finds a different pair than the main solution: sort the
// positions by value and close in from both ends. The checker must accept it.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    long long t;
    cin >> n >> t;
    vector<long long> a(n);
    for (auto &x : a)
        cin >> x;

    vector<int> order(n);
    iota(order.begin(), order.end(), 0);
    sort(order.begin(), order.end(), [&](int x, int y) { return a[x] < a[y]; });

    int lo = 0, hi = n - 1;
    while (lo < hi)
    {
        long long sum = a[order[lo]] + a[order[hi]];
        if (sum == t)
        {
            cout << order[hi] + 1 << ' ' << order[lo] + 1 << '\n';
            return 0;
        }
        if (sum < t)
            lo++;
        else
            hi--;
    }
    cout << -1 << '\n';
    return 0;
}
