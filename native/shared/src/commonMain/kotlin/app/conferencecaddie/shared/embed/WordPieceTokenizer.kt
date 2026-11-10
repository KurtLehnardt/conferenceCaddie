package app.conferencecaddie.shared.embed

/** Placeholder until the WordPiece tokenizer lands; replaced in the next commit. */
class WordPieceTokenizer private constructor(private val vocab: Map<String, Int>) {
    fun encode(text: String, maxTokens: Int = 512): IntArray {
        val cls = vocab.getValue("[CLS]")
        val sep = vocab.getValue("[SEP]")
        val unk = vocab.getValue("[UNK]")
        val body = text.lowercase().split(' ').filter { it.isNotEmpty() }.map { vocab[it] ?: unk }.take(maxTokens - 2)
        return (listOf(cls) + body + sep).toIntArray()
    }

    companion object {
        fun fromVocab(text: String): WordPieceTokenizer =
            WordPieceTokenizer(text.split('\n').withIndex().associate { (i, t) -> t.trimEnd('\r') to i })
    }
}
