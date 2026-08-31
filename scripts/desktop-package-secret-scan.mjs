const privateKeyPattern = /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/i;
const openGroveTokenPattern = /x-opengrove-token\s*[:=]/i;
const credentialPropertyPattern = /(?:^|[,{])\s*["']?(?:registryToken|apiKey)["']?\s*:\s*["'][^"']+["']/i;

export function containsPossibleDesktopPackageSecret(content) {
  return (
    privateKeyPattern.test(content) || openGroveTokenPattern.test(content) || credentialPropertyPattern.test(content)
  );
}
