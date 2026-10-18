# Mutant (TL) in Python: right answers, but it checks every pair, which is
# hopeless for n = 10^5 within the time limit.
n, k = map(int, input().split())
a = list(map(int, input().split()))
pairs = 0
for i in range(n):
    for j in range(i + 1, n):
        if (a[i] + a[j]) % k == 0:
            pairs += 1
print(pairs)
