import com.android.apksig.ApkSigner;
import com.android.apksig.ApkVerifier;

import java.io.File;
import java.io.FileInputStream;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.Collections;

/** Signs an APK (APK Signature Scheme v2) with a PKCS#12 key and verifies the result.
 *  java -cp apksig.jar Sign.java <keystore.p12> <password> <alias> <in.apk> <out.apk> */
public class Sign {
    public static void main(String[] a) throws Exception {
        char[] pass = a[1].toCharArray();
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (FileInputStream in = new FileInputStream(a[0])) { ks.load(in, pass); }
        PrivateKey key = (PrivateKey) ks.getKey(a[2], pass);
        X509Certificate cert = (X509Certificate) ks.getCertificate(a[2]);
        ApkSigner.SignerConfig signer = new ApkSigner.SignerConfig.Builder("BUDGET", key, Collections.singletonList(cert)).build();
        new ApkSigner.Builder(Collections.singletonList(signer))
                .setInputApk(new File(a[3]))
                .setOutputApk(new File(a[4]))
                .setMinSdkVersion(24)
                .setV1SigningEnabled(false) // v1 is only needed below Android 7.0 (minSdk is 24)
                .setV2SigningEnabled(true)
                .build()
                .sign();
        ApkVerifier.Result r = new ApkVerifier.Builder(new File(a[4])).build().verify();
        System.out.println("verified=" + r.isVerified() + " v1=" + r.isVerifiedUsingV1Scheme() + " v2=" + r.isVerifiedUsingV2Scheme());
        for (Object e : r.getErrors()) System.out.println("error: " + e);
        for (Object w : r.getWarnings()) System.out.println("warning: " + w);
        if (!r.isVerified()) System.exit(1);
    }
}
