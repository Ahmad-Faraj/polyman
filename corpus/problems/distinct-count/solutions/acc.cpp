// Main solution: sort each test case's array and count the runs.
#include <bits/stdc++.h>

using namespace std;

int main()
{
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int T;
    cin >> T;
    while (T--)
    {
        int n;
        cin >> n;
        vector<int> a(n);
        for (auto &x : a)
            cin >> x;
        sort(a.begin(), a.end());
        cout << unique(a.begin(), a.end()) - a.begin() << '\n';
    }
    return 0;
}
