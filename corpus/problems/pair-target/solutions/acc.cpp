// Main solution: for each position j, look up t - a[j] among the earlier positions.
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

    map<long long, int> seen;
    for (int j = 0; j < n; j++)
    {
        auto it = seen.find(t - a[j]);
        if (it != seen.end())
        {
            cout << it->second + 1 << ' ' << j + 1 << '\n';
            return 0;
        }
        seen.emplace(a[j], j);
    }
    cout << -1 << '\n';
    return 0;
}
