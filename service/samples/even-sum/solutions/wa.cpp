#include <bits/stdc++.h>
using namespace std;

// Wrong on purpose: only looks at the first element's parity.
int main() {
    int n;
    cin >> n;
    vector<int> a(n);
    for (int &x : a) cin >> x;
    cout << (a[0] % 2 == 0 ? "YES" : "NO") << "\n";
}
